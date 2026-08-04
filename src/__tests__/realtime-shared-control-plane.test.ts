import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../config/database", () => ({
  default: {
    connect: mocks.connect,
    query: mocks.query,
  },
}));

import {
  PostgresRealtimeControlPlane,
  enqueueRealtimeEvent,
  getRealtimeControlPlaneMetrics,
  resetRealtimeControlPlaneMetrics,
} from "../shared/realtime/realtime-control-plane";

const retiredBasePatchPath = resolve(process.cwd(), "db/patches/20260804_realtime_shared_control_plane.sql");
const patchPath = resolve(process.cwd(), "db/patches/20260804_realtime_control_plane_v2.sql");
const supportPath = resolve(process.cwd(), "db/patches/support");
const retiredV1Sha256 = "a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6";

function lockUpdatedPayload(entityId: string) {
  return {
    entityType: "OF",
    entityId,
    locked: true,
    lock: {
      id: `lock-${entityId}`,
      entityType: "OF",
      entityId,
      lockedBy: { id: 1, name: "Test" },
      lockedAt: "2026-08-04T10:00:00.000Z",
      expiresAt: "2026-08-04T10:05:00.000Z",
    },
  };
}

function outillageEntityPayload(entityId: string, action: "created" | "updated" = "updated") {
  return {
    entityType: "OUTIL",
    entityId,
    action,
    module: "outillage",
    at: "2026-08-04T10:00:00.000Z",
    invalidateKeys: ["outils"],
  };
}

function executableSql(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/'(?:''|[^'])*'/g, "''");
}

const privilegedFunctionNames = [
  "cerp_realtime_bump_session_epoch",
  "cerp_realtime_bump_authorization_epoch",
  "cerp_realtime_enqueue_audit_event",
] as const;

function generatedPrivilegedFunctionHashes(installer: string): Map<string, string> {
  return new Map(privilegedFunctionNames.map((functionName) => {
    const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = installer.match(new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${escapedName}\\(\\)[\\s\\S]*?AS \\$function\\$\\r?\\n([\\s\\S]*?)\\r?\\n\\$function\\$;`
    ));
    if (!match?.[1]) throw new Error(`Missing privileged function body: ${functionName}`);
    // Mirrors PostgreSQL verification exactly: collapse every whitespace run
    // first, then btrim the ASCII spaces produced at the body boundaries.
    const normalizedBody = match[1].replace(/\s+/g, " ").replace(/^ +| +$/g, "");
    return [functionName, createHash("md5").update(normalizedBody, "utf8").digest("hex")];
  }));
}

function declaredPrivilegedFunctionHashes(consumer: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const declaration = /\('public\.(cerp_realtime_[a-z_]+)\(\)'::text,\s*'([0-9a-f]{32})'::text\)/g;
  for (const match of consumer.matchAll(declaration)) hashes.set(match[1], match[2]);
  return hashes;
}

describe("shared realtime control plane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRealtimeControlPlaneMetrics();
  });

  it("retires v1 safely and supports both a clean database and an applied-v1 database", () => {
    const patch = readFileSync(patchPath, "utf8");
    // V1 is intentionally absent from disk, but every consumer pins the exact
    // historic ledger checksum rather than accepting an arbitrary hex value.
    expect(existsSync(retiredBasePatchPath)).toBe(false);
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.realtime_session_epochs");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.realtime_event_log");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.realtime_control_plane_v2_provenance");
    expect(patch).toContain("WHERE filename = '20260804_realtime_shared_control_plane.sql'");
    expect(patch).toContain(`sha256 = '${retiredV1Sha256}'`);
    expect(patch).toContain("source_v1_sha256 text");
    expect(patch).not.toContain("sha256 ~ '^[0-9a-f]{64}$'");
    expect(patch).toContain("SELECT last_value::bigint, is_called FROM public.realtime_event_log_sequence_seq");
    expect(patch).toContain("v_initial_last := GREATEST(COALESCE(v_max, 0), v_allocated_through) + 1");
    expect(patch).toContain("v_initial_pruned := v_initial_last");
    expect(patch).toContain("every cursor issued by V1");
    expect(patch).not.toContain("GREATEST(COALESCE(v_min, 1) - 1, 0)");
    expect(patch).toContain("ambiguous partial v1 state");
    expect(patch).toContain("(NOT v_has_ledger AND NOT v_has_sessions AND NOT v_has_events AND NOT v_has_sequence)");
    expect(patch).toContain("(v_has_ledger AND v_has_sessions AND v_has_events AND v_has_sequence)");
    expect(patch).toContain("ON CONFLICT (singleton) DO UPDATE");
    expect(patch).toContain("ALTER COLUMN sequence DROP DEFAULT");
    expect(patch).toContain("not rolling-compatible");
    expect(patch).toContain("SEC-CERP-0004 v2 refused: legacy realtime outbox stream cannot be backfilled safely");
    expect(patch.indexOf("legacy realtime outbox stream cannot be backfilled safely"))
      .toBeLessThan(patch.indexOf("WITH ranked AS"));
    expect(executableSql(patch)).not.toMatch(/\bCREATE\s+TRIGGER\b/i);
  });

  it("reserves a replay barrier above gapped or tail-pruned v1 history", () => {
    const patch = readFileSync(patchPath, "utf8");
    // A v1 log containing only sequences 1 and 100 cannot prove whether 50
    // was ever visible. The v2 watermark must therefore be > 100, not MIN-1.
    expect(patch).toContain("GREATEST(COALESCE(v_max, 0), v_allocated_through) + 1");
    expect(patch).toContain("initial_last_sequence, initial_pruned_through");
    expect(patch).not.toMatch(/v_initial_pruned\s*:=\s*.*v_min/i);
  });

  it("retries only bounded transient publish failures with one stable idempotency key", async () => {
    const attemptedEventIds: string[] = [];
    let connectionNo = 0;
    mocks.connect.mockImplementation(async () => {
      connectionNo += 1;
      const thisConnection = connectionNo;
      return {
        release: vi.fn(),
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes("INSERT INTO public.realtime_event_log")) {
            attemptedEventIds.push(String(params?.[1]));
            if (thisConnection < 3) throw Object.assign(new Error("temporary outage"), { code: "08006" });
            return {
              rows: [{
                sequence: "41",
                event_id: params?.[1],
                stream_id: "entity:OF:41",
                event_name: "lock:updated",
                payload: lockUpdatedPayload("41"),
                targets: [{ scope: "entity", entityType: "OF", entityId: "41" }],
                occurred_at: "2026-08-04T10:00:00.000Z",
              }],
            };
          }
          if (sql.includes("UPDATE public.realtime_event_sequence_state")) {
            return { rows: [{ sequence: "41" }] };
          }
          return { rows: [], rowCount: 0 };
        }),
      };
    });
    const controlPlane = new PostgresRealtimeControlPlane();

    const record = await controlPlane.publish({
      event: "lock:updated",
      payload: lockUpdatedPayload("41"),
      targets: [{ scope: "entity", entityType: "OF", entityId: "41" }],
      streamId: "entity:OF:41",
      deduplicationKey: "lock:test:41",
    });

    expect(record.sequence).toBe(41n);
    expect(connectionNo).toBe(3);
    expect(new Set(attemptedEventIds).size).toBe(1);
    expect(getRealtimeControlPlaneMetrics()).toEqual(expect.objectContaining({
      publishRetries: 2,
      publishFailures: 0,
    }));
  });

  it("does not retry a permanent publish rejection", async () => {
    mocks.connect.mockResolvedValue({
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        if (sql.includes("UPDATE public.realtime_event_sequence_state")) {
          return { rows: [{ sequence: "1" }] };
        }
        if (sql.includes("INSERT INTO public.realtime_event_log")) {
          throw Object.assign(new Error("invalid schema"), { code: "42P01" });
        }
        return { rows: [], rowCount: 0 };
      }),
    });
    const controlPlane = new PostgresRealtimeControlPlane();
    await expect(controlPlane.publish({
      event: "entity:changed",
      payload: outillageEntityPayload("42"),
      targets: [
        { scope: "module", moduleKey: "outillage" },
        { scope: "entity", entityType: "OUTIL", entityId: "42" },
      ],
      streamId: "entity:OUTIL:42",
    })).rejects.toThrow("invalid schema");
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(getRealtimeControlPlaneMetrics().publishFailures).toBe(1);
  });

  it("keeps retry idempotent but preserves two semantically identical mutations", async () => {
    const stored = new Map<string, { eventId: string; input: unknown }>();
    const tx = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const eventKey = String(params?.[0]);
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (sql.includes("SELECT") && sql.includes("FROM public.erp_outbox_events")) {
          const existing = stored.get(eventKey);
          return existing
            ? { rows: [{ event_id: existing.eventId, same_content: JSON.stringify(existing.input) === JSON.stringify(JSON.parse(String(params?.[1]))) }] }
            : { rows: [] };
        }
        if (sql.includes("INSERT INTO public.realtime_stream_enqueue_state")) {
          return { rows: [{ stream_ordinal: String(stored.size + 1) }] };
        }
        const envelope = JSON.parse(String(params?.[4])) as { eventId: string; input: unknown };
        stored.set(eventKey, { eventId: envelope.eventId, input: envelope.input });
        return { rows: [{ event_id: envelope.eventId }] };
      }),
    };
    const input = {
      event: "entity:changed",
      payload: outillageEntityPayload("42"),
      targets: [
        { scope: "module" as const, moduleKey: "outillage" },
        { scope: "entity" as const, entityType: "OUTIL", entityId: "42" },
      ],
      streamId: "entity:OUTIL:42",
    };

    const first = await enqueueRealtimeEvent(tx, { ...input, deduplicationKey: "outil:update:mutation-1" });
    const retry = await enqueueRealtimeEvent(tx, { ...input, deduplicationKey: "outil:update:mutation-1" });
    const repeatedMutation = await enqueueRealtimeEvent(tx, { ...input, deduplicationKey: "outil:update:mutation-2" });

    expect(retry).toBe(first);
    expect(repeatedMutation).not.toBe(first);
    expect(stored.size).toBe(2);
    await expect(enqueueRealtimeEvent(tx, {
      ...input,
      payload: outillageEntityPayload("42", "created"),
      deduplicationKey: "outil:update:mutation-1",
    })).rejects.toThrow("REALTIME_OUTBOX_KEY_COLLISION");
  });

  it.each([
    ["unknown capability", [{ scope: "capability", capability: "admin:everything" }]],
    ["unknown module", [{ scope: "module", moduleKey: "secret-module" }]],
    ["mixed valid and invalid targets", [
      { scope: "module", moduleKey: "production" },
      { scope: "capability", capability: "admin:everything" },
    ]],
  ])("quarantines an outbox envelope with %s before publishing", async (_label, targets) => {
    const eventId = "00000000-0000-4000-8000-000000000099";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.erp_outbox_events candidate")) {
        return {
          rows: [{
            id: eventId,
            realtime_stream_id: "rt:module:production",
            realtime_stream_ordinal: "1",
            payload: {
              schemaVersion: 1,
              eventId,
              input: {
                event: "entity:changed",
                payload: { id: 42 },
                targets,
                streamId: "rt:module:production",
                deduplicationKey: "invalid-target-test",
              },
            },
          }],
        };
      }
      if (sql.includes("UPDATE public.realtime_event_sequence_state") && sql.includes("RETURNING last_sequence")) {
        return { rows: [{ barrier: "1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    mocks.connect.mockResolvedValueOnce({ query, release });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(new PostgresRealtimeControlPlane().flushOutbox(1)).resolves.toBe(0);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("available_at = 'infinity'::timestamptz"),
      [eventId, "QUARANTINED:INVALID_REALTIME_ENVELOPE"]
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.realtime_event_log"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status = 'PUBLISHED'"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("realtime_event_quarantine"))).toBe(true);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("realtime_outbox_quarantined"));
    errorLog.mockRestore();
  });

  it.each([
    ["event high-water exceeds allocator", { latest_sequence: "0", pruned_through: "0", max_event_sequence: "42" }],
    ["prune watermark exceeds allocator", { latest_sequence: "42", pruned_through: "43", max_event_sequence: "42" }],
  ])("rejects corrupt retention state when %s", async (_label, corrupt) => {
    mocks.query.mockResolvedValue({
      rows: [{ ...corrupt, earliest_sequence: null }],
    });
    await expect(new PostgresRealtimeControlPlane().retentionState())
      .rejects.toThrow("REALTIME_SEQUENCE_STATE_CORRUPT");
  });

  it("reports invalid runtime integrity when the deduplication unique constraint is absent", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          provenance_valid: true,
          sequence_default_removed: true,
          constraints_valid: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          latest_sequence: "42",
          earliest_sequence: null,
          pruned_through: "0",
          max_event_sequence: "42",
        }],
      });

    await expect(new PostgresRealtimeControlPlane().integrityStatus()).resolves.toEqual({
      valid: false,
      stateValid: true,
      provenanceValid: true,
      sequenceDefaultRemoved: true,
      constraintsValid: false,
    });
  });

  it("invalidates every session epoch and the shared authorization epoch before backstop recovery", async () => {
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE public.realtime_authorization_epoch")) {
        return { rows: [{ epoch: "9" }] };
      }
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release });

    await expect(new PostgresRealtimeControlPlane().reconcileAuthorizationAfterBackstopOutage())
      .resolves.toBeUndefined();

    expect(query.mock.calls.some(([sql]) => String(sql).includes(
      "INSERT INTO public.realtime_session_epochs (user_id, session_epoch, updated_at)"
    ))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes(
      "SELECT users.id, 1, clock_timestamp()"
    ))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes(
      "public.realtime_session_epochs.session_epoch + 1"
    ))).toBe(true);
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("destroys a publish connection after a lost COMMIT acknowledgement", async () => {
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    let storedEventId: string | null = null;
    const storedRow = (sameContent = false) => ({
      sequence: "7",
      event_id: storedEventId,
      stream_id: "entity:OF:7",
      event_name: "lock:updated",
      payload: lockUpdatedPayload("7"),
      targets: [{ scope: "entity", entityType: "OF", entityId: "7" }],
      occurred_at: "2026-08-04T10:00:00.000Z",
      same_content: sameContent,
    });
    const firstQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("UPDATE public.realtime_event_sequence_state")) return { rows: [{ sequence: "7" }] };
      if (sql.includes("INSERT INTO public.realtime_event_log")) {
        storedEventId = String(params?.[1]);
        return { rows: [storedRow()] };
      }
      if (sql === "COMMIT") throw Object.assign(new Error("commit ack lost"), { code: "08006" });
      return { rows: [] };
    });
    const secondQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.realtime_event_log")) return { rows: [storedRow(true)] };
      return { rows: [] };
    });
    mocks.connect
      .mockResolvedValueOnce({ query: firstQuery, release: firstRelease })
      .mockResolvedValueOnce({ query: secondQuery, release: secondRelease });

    const record = await new PostgresRealtimeControlPlane().publish({
      event: "lock:updated",
      payload: lockUpdatedPayload("7"),
      targets: [{ scope: "entity", entityType: "OF", entityId: "7" }],
      streamId: "entity:OF:7",
      deduplicationKey: "lock:7:mutation-1",
    });

    expect(record.eventId).toBe(storedEventId);
    expect(firstRelease).toHaveBeenCalledWith(true);
    expect(secondRelease).toHaveBeenCalledWith(false);
    expect(firstQuery).not.toHaveBeenCalledWith("ROLLBACK");
  });

  it("destroys an outbox worker connection after lost COMMIT ack and reconciles on retry", async () => {
    const eventId = "00000000-0000-4000-8000-000000000077";
    const envelope = {
      schemaVersion: 1,
      eventId,
      input: {
        event: "entity:changed",
        payload: outillageEntityPayload("77"),
        targets: [
          { scope: "module", moduleKey: "outillage" },
          { scope: "entity", entityType: "OUTIL", entityId: "77" },
        ],
        streamId: "entity:OUTIL:77",
        deduplicationKey: "outil:update:mutation-77",
      },
    };
    const firstRelease = vi.fn();
    const retryRelease = vi.fn();
    const row = {
      sequence: "77",
      event_id: eventId,
      stream_id: envelope.input.streamId,
      event_name: envelope.input.event,
      payload: envelope.input.payload,
      targets: envelope.input.targets,
      occurred_at: "2026-08-04T10:00:00.000Z",
    };
    const firstQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.erp_outbox_events")) return { rows: [{
        id: eventId,
        payload: envelope,
        realtime_stream_id: envelope.input.streamId,
        realtime_stream_ordinal: "1",
      }] };
      if (sql.includes("UPDATE public.realtime_event_sequence_state")) return { rows: [{ sequence: "77" }] };
      if (sql.includes("INSERT INTO public.realtime_event_log")) return { rows: [row] };
      if (sql === "COMMIT") throw Object.assign(new Error("commit ack lost"), { code: "08006" });
      return { rows: [] };
    });
    const retryQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.erp_outbox_events")) return { rows: [{
        id: eventId,
        payload: envelope,
        realtime_stream_id: envelope.input.streamId,
        realtime_stream_ordinal: "1",
      }] };
      if (sql.includes("FROM public.realtime_event_log")) return { rows: [{ ...row, same_content: true }] };
      return { rows: [] };
    });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.connect
      .mockResolvedValueOnce({ query: firstQuery, release: firstRelease })
      .mockResolvedValueOnce({ query: retryQuery, release: retryRelease });
    const controlPlane = new PostgresRealtimeControlPlane();

    await expect(controlPlane.flushOutbox(1)).rejects.toThrow("commit ack lost");
    await expect(controlPlane.flushOutbox(1)).resolves.toBe(1);

    expect(firstRelease).toHaveBeenCalledWith(true);
    expect(retryRelease).toHaveBeenCalledWith(false);
    expect(firstQuery).not.toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("AND status <> 'PUBLISHED'"),
      [eventId, "Error"]
    );
  });

  it("reconciles a lost session-revocation COMMIT using the durable epoch", async () => {
    const primaryRelease = vi.fn();
    const verifierRelease = vi.fn();
    const primaryQuery = vi.fn(async (sql: string) => {
      if (sql.includes("WITH bumped AS")) return { rows: [{ session_epoch: "4" }] };
      if (sql === "COMMIT") throw new Error("commit ack lost");
      return { rows: [] };
    });
    const verifierQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.realtime_session_epochs")) return { rows: [{ session_epoch: "4" }] };
      return { rows: [] };
    });
    mocks.connect
      .mockResolvedValueOnce({ query: primaryQuery, release: primaryRelease })
      .mockResolvedValueOnce({ query: verifierQuery, release: verifierRelease });

    await expect(new PostgresRealtimeControlPlane().revokeSessions(91)).resolves.toBe(4);
    expect(primaryRelease).toHaveBeenCalledWith(true);
    expect(primaryQuery).not.toHaveBeenCalledWith("ROLLBACK");
    expect(verifierQuery).toHaveBeenCalledWith(expect.stringContaining("realtime_session_epochs"), [91]);
    expect(verifierRelease).toHaveBeenCalledWith();
  });

  it("reconciles a lost retention-prune COMMIT using the durable watermark", async () => {
    const primaryRelease = vi.fn();
    const verifierRelease = vi.fn();
    const primaryQuery = vi.fn(async (sql: string) => {
      if (sql.includes("WITH expired AS")) {
        return { rows: [{ pruned_through: "9", deleted_count: "2" }] };
      }
      if (sql === "COMMIT") throw new Error("commit ack lost");
      return { rows: [] };
    });
    const verifierQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT pruned_through::text")) return { rows: [{ pruned_through: "9" }] };
      return { rows: [] };
    });
    mocks.connect
      .mockResolvedValueOnce({ query: primaryQuery, release: primaryRelease })
      .mockResolvedValueOnce({ query: verifierQuery, release: verifierRelease });

    await expect(new PostgresRealtimeControlPlane().pruneExpired()).resolves.toBe(2);
    expect(primaryRelease).toHaveBeenCalledWith(true);
    expect(primaryQuery).not.toHaveBeenCalledWith("ROLLBACK");
    expect(verifierRelease).toHaveBeenCalledWith();
  });

  it("ships v2 upgrade, read-only preflight/verify, and provenance-aware guarded rollbacks", () => {
    const patch = readFileSync(patchPath, "utf8");
    const preflight = readFileSync(resolve(supportPath, "20260804_realtime_control_plane_v2.preflight.sql"), "utf8");
    const verify = readFileSync(resolve(supportPath, "20260804_realtime_control_plane_v2.verify.sql"), "utf8");
    const rollback = readFileSync(resolve(supportPath, "20260804_realtime_control_plane_v2.rollback.sql"), "utf8");
    const privileged = readFileSync(
      resolve(process.cwd(), "db/privileged/20260804_realtime_control_plane_triggers.sql"),
      "utf8"
    );
    const privilegedRollback = readFileSync(
      resolve(process.cwd(), "db/privileged/20260804_realtime_control_plane_triggers.rollback.sql"),
      "utf8"
    );
    const privilegedVerify = readFileSync(
      resolve(process.cwd(), "db/privileged/20260804_realtime_control_plane_triggers.verify.sql"),
      "utf8"
    );
    const controlPlaneSource = readFileSync(
      resolve(process.cwd(), "src/shared/realtime/realtime-control-plane.ts"),
      "utf8"
    );
    const runner = readFileSync(resolve(process.cwd(), "scripts/db-patches.js"), "utf8");
    const generatedHashes = generatedPrivilegedFunctionHashes(privileged);
    const expectedHashes = new Map([
      ["cerp_realtime_bump_session_epoch", "eaa359d0643f761d7e8715e5a1206c4b"],
      ["cerp_realtime_bump_authorization_epoch", "70c4324341adf301e9d3c8764819b641"],
      ["cerp_realtime_enqueue_audit_event", "baf6cd29532fad08842655261bed08c6"],
    ]);

    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.realtime_session_epochs");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.realtime_event_log");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.realtime_event_sequence_state");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.realtime_authorization_epoch");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.realtime_control_plane_v2_provenance");
    expect(executableSql(patch)).not.toMatch(/\bCREATE\s+TRIGGER\b/i);
    expect(privileged).toContain("erp_audit_logs_realtime_outbox_trg");
    expect(privileged).toContain("users_realtime_session_update_trg");
    expect(privileged).toContain("IF TG_LEVEL = 'STATEMENT' THEN");
    expect(privileged).toContain("rolsuper");
    expect(privileged).toContain("SET search_path = pg_catalog");
    expect(privileged).not.toContain("SET search_path = pg_catalog, public");
    expect(privileged).toContain("OWNER TO postgres");
    expect(privileged).toContain("pg_advisory_xact_lock(860804120012::bigint)");
    expect(privileged).toContain("realtime_stream_ordinal");
    expect(privileged).toContain("RAISE EXCEPTION 'REALTIME_OUTBOX_KEY_COLLISION'");
    expect(privileged).toContain("aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner)))");
    expect(generatedHashes).toEqual(expectedHashes);
    expect(declaredPrivilegedFunctionHashes(privilegedVerify)).toEqual(generatedHashes);
    expect(declaredPrivilegedFunctionHashes(controlPlaneSource)).toEqual(generatedHashes);
    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY;");
    expect(preflight).toContain("to_regclass('public.cerp_schema_migrations') IS NULL");
    expect(preflight).toContain(`sha256 = '${retiredV1Sha256}'`);
    expect(preflight).not.toContain("sha256 ~ '^[0-9a-f]{64}$'");
    expect(preflight).toContain("applied_at IS NOT NULL");
    expect(verify).toContain("BEGIN TRANSACTION READ ONLY;");
    expect(verify).toContain("filename = '20260804_realtime_control_plane_v2.sql'");
    expect(verify).toContain("migration ledger row missing or invalid");
    expect(verify).toContain("sha256 ~ '^[0-9a-f]{64}$'");
    expect(verify).toContain(`source_v1_sha256 <> '${retiredV1Sha256}'`);
    expect(verify).toContain("immutable v1 provenance mismatch");
    expect(runner).toContain(`const REALTIME_V1_SHA256 = "${retiredV1Sha256}"`);
    expect(runner).toContain("assertImmutableRealtimeV1Provenance");
    expect(runner).toContain("immutable v1 provenance does not match the migration ledger");
    expect(verify).toContain("applied_at <= clock_timestamp()");
    expect(verify).toContain("v_last_sequence < COALESCE(v_max_event_sequence, 0)");
    expect(verify).toContain("v_pruned_through > v_last_sequence");
    expect(verify).toContain("legacy sequence default still installed");
    expect(verify).toContain("realtime_event_log_deduplication_key_uq");
    expect(verify).toContain("provenance inconsistent");
    expect(verify).toContain("has_table_privilege('cerp_app'");
    expect(verify).not.toContain("has_table_privilege(current_user");
    expect(executableSql(preflight)).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
    expect(executableSql(verify)).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("DELETE FROM public.cerp_schema_migrations");
    expect(rollback).toContain("filename = '20260804_realtime_control_plane_v2.sql'");
    expect(rollback).toContain("rollback refused");
    expect(rollback).toContain("baseline_event_count");
    expect(rollback).toContain("v_current_event_count IS DISTINCT FROM v_baseline_event_count");
    expect(rollback).toContain("v_pruned_through IS DISTINCT FROM v_initial_pruned_through");
    expect(rollback).toContain("v_baseline_sequence_is_called");
    expect(rollback).toContain("IF v_inherited_v1 THEN");
    expect(rollback).toContain("ALTER COLUMN sequence SET DEFAULT nextval");
    expect(rollback).toContain("DROP TABLE public.realtime_event_log");
    expect(rollback).toContain("DROP TABLE public.realtime_session_epochs");
    expect(rollback).toContain("exécutez d''abord db/privileged/20260804_realtime_control_plane_triggers.rollback.sql");
    expect(rollback.indexOf("erp_audit_logs_realtime_outbox_trg"))
      .toBeLessThan(rollback.indexOf("DROP TABLE public.realtime_authorization_epoch"));
    expect(privilegedRollback).toContain("SELECT inherited_v1, recorded_at");
    expect(privilegedRollback).toContain("current_database() <> 'cerp_test'");
    expect(privilegedRollback.indexOf("v2 control-plane usage detected"))
      .toBeLessThan(privilegedRollback.indexOf("DROP TRIGGER IF EXISTS"));
    expect(privilegedRollback).toContain("AFTER UPDATE OF password, role, status ON public.users");
    expect(privilegedRollback).not.toContain("AFTER UPDATE OF password, role, status, is_superadmin ON public.users");
    expect(privilegedRollback).toContain("IF NOT COALESCE(v_inherited_v1, false) THEN");
    expect(privilegedRollback).toContain("DROP FUNCTION public.cerp_realtime_bump_session_epoch()");
    for (const source of [privilegedVerify, controlPlaneSource]) {
      expect(source).toContain("tgenabled IN ('O', 'A')");
      expect(source).toContain("tgfoid = to_regprocedure");
      expect(source).toContain("tgtype = expected.trigger_type");
      expect(source).toContain("tgrelid = to_regclass(expected.relation_name)");
      expect(source).toContain("required_definition");
      expect(source).toContain("normalized_body_md5");
      expect(source).toContain("procedure.prosecdef");
      expect(source).toContain("procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]");
      expect(source).toContain("pg_get_userbyid(procedure.proowner) = 'postgres'");
    }
    expect(privilegedVerify).not.toContain("tgenabled <> 'D'");
    expect(privilegedVerify).toContain("procedure.prosecdef");
    expect(privilegedVerify).toContain("pg_get_userbyid(procedure.proowner) = 'postgres'");
    expect(privilegedVerify).toContain("procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]");
    for (const source of [privilegedVerify, controlPlaneSource]) {
      expect(source).toContain("md5(btrim(regexp_replace(procedure.prosrc");
      expect(source).not.toContain("md5(regexp_replace(btrim(procedure.prosrc)");
    }
    expect(privilegedVerify).toContain("aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner)))");
  });
});
