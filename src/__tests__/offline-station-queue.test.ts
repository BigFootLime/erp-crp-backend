import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "../utils/httpError";
import { repoRoot } from "./helpers/repo-paths";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  reserve: vi.fn(),
  complete: vi.fn(),
  dependency: vi.fn(),
  canonicalExists: vi.fn(),
  purge: vi.fn(),
  audit: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  quantity: vi.fn(),
}));

vi.mock("../module/production/repository/offline-station.repository", () => ({
  repoOfflineSyncEnabled: mocks.enabled,
  repoReserveOfflineEvent: mocks.reserve,
  repoCompleteOfflineEvent: mocks.complete,
  repoOfflineDependency: mocks.dependency,
  repoCanonicalIdempotencyExists: mocks.canonicalExists,
  repoPurgeOfflineEvents: mocks.purge,
}));
vi.mock("../module/production/repository/station.repository", () => ({ repoStationAudit: mocks.audit }));
vi.mock("../module/production/services/production-execution.service", () => ({
  svcStartExecution: mocks.start,
  svcStopExecution: mocks.stop,
  svcDeclareQuantity: mocks.quantity,
}));

import { svcSyncOfflineStation } from "../module/production/services/offline-station.service";
import { offlineStationSyncSchema } from "../module/production/validators/offline-station.validators";

const DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MACHINE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EVENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STOP_EVENT = "12121212-1212-4121-8121-121212121212";
const ENTITY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BATCH = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const station = {
  session_id: SESSION,
  device_id: DEVICE,
  device_code: "TAB-0001",
  device_zone: "USINAGE",
  device_assignment_mode: "FIXED" as const,
  machine_id: MACHINE,
  user: { id: 7, username: "operator", name: null, surname: null, role: "Operateur CN" },
  auto_lock_seconds: 180,
};
const audit = {
  user_id: 7,
  user_role: "Operateur CN",
  ip: null,
  user_agent: null,
  device_type: "tablet",
  os: null,
  browser: null,
  path: "/api/v1/production/station/offline/sync",
  page_key: "atelier-offline-sync",
  client_session_id: SESSION,
};

function startBatch(overrides: Record<string, unknown> = {}) {
  return offlineStationSyncSchema.parse({
    client_batch_id: BATCH,
    events: [{
      event_id: EVENT,
      idempotency_key: "offline-start-000001",
      type: "POINTAGE_START",
      occurred_at: new Date().toISOString(),
      device_id: DEVICE,
      user_id: 7,
      station_session_id: SESSION,
      machine_id: MACHINE,
      payload: { of_id: 42, activity_code: "PRODUCTION" },
      ...overrides,
    }],
  });
}

function processing(existing = false) {
  return {
    kind: "RESERVED" as const,
    existing,
    outcome: {
      event_id: EVENT,
      status: "PROCESSING" as const,
      result_payload: null,
      error_code: null,
      error_message: null,
      server_entity_id: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.STATION_OFFLINE_SYNC_ENABLED;
  mocks.enabled.mockResolvedValue(true);
  mocks.reserve.mockResolvedValue(processing());
  mocks.complete.mockResolvedValue(undefined);
  mocks.canonicalExists.mockResolvedValue(false);
  mocks.purge.mockResolvedValue(0);
  mocks.audit.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue({ id: ENTITY });
});

describe("GPT56-FEAT-CERP-0006 — contrat borné", () => {
  it("n'accepte que les trois événements et 25 éléments au maximum", () => {
    expect(startBatch().events[0]?.type).toBe("POINTAGE_START");
    expect(() => startBatch({ type: "QUALITY_RELEASE" })).toThrow();
    expect(() => startBatch({ occurred_at: "2026-08-05" })).toThrow();
    const one = startBatch().events[0];
    expect(() => offlineStationSyncSchema.parse({
      client_batch_id: BATCH,
      events: Array.from({ length: 26 }, (_, index) => ({
        ...one,
        event_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        idempotency_key: `offline-${index}-unique`,
      })),
    })).toThrow();
  });

  it("refuse les doublons internes et une quantité nulle", () => {
    const event = startBatch().events[0];
    expect(() => offlineStationSyncSchema.parse({ client_batch_id: BATCH, events: [event, event] })).toThrow();
    expect(() => offlineStationSyncSchema.parse({
      client_batch_id: BATCH,
      events: [{
        ...event,
        type: "QUANTITY_DECLARE",
        payload: { of_id: 42, qty_good: 0 },
      }],
    })).toThrow();
  });

  it("double sync: applique une fois puis renvoie le reçu synchronisé", async () => {
    mocks.reserve
      .mockResolvedValueOnce(processing())
      .mockResolvedValueOnce({
        kind: "RESERVED",
        existing: true,
        outcome: {
          event_id: EVENT,
          status: "SYNCED",
          result_payload: { server_entity_id: ENTITY },
          error_code: null,
          error_message: null,
          server_entity_id: ENTITY,
        },
      });
    const body = startBatch();
    const first = await svcSyncOfflineStation({ body, station, audit });
    const second = await svcSyncOfflineStation({ body, station, audit });
    expect(first.results[0]).toMatchObject({ status: "SYNCED", replayed: false, server_entity_id: ENTITY });
    expect(second.results[0]).toMatchObject({ status: "SYNCED", replayed: true, server_entity_id: ENTITY });
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("résout un STOP vers le START local synchronisé juste avant dans le même lot", async () => {
    const start = startBatch().events[0]!;
    const body = offlineStationSyncSchema.parse({
      client_batch_id: BATCH,
      events: [
        start,
        {
          event_id: STOP_EVENT,
          idempotency_key: "offline-stop-000001",
          type: "POINTAGE_STOP",
          occurred_at: new Date().toISOString(),
          device_id: DEVICE,
          user_id: 7,
          station_session_id: SESSION,
          machine_id: MACHINE,
          payload: { pointage_id: null, start_event_id: EVENT },
        },
      ],
    });
    mocks.reserve.mockImplementation(({ event }: { event: { event_id: string } }) => Promise.resolve({
      ...processing(),
      outcome: { ...processing().outcome, event_id: event.event_id },
    }));
    mocks.dependency.mockResolvedValue({
      event_id: EVENT,
      status: "SYNCED",
      result_payload: { server_entity_id: ENTITY },
      error_code: null,
      error_message: null,
      server_entity_id: ENTITY,
    });
    mocks.stop.mockResolvedValue({ id: ENTITY });
    const result = await svcSyncOfflineStation({ body, station, audit });
    expect(result.results.map((item) => item.status)).toEqual(["SYNCED", "SYNCED"]);
    expect(mocks.stop).toHaveBeenCalledWith(expect.objectContaining({ id: ENTITY }));
  });

  it("reprend après un crash entre effet canonique et reçu sans nouvel effet logique", async () => {
    mocks.reserve.mockResolvedValueOnce(processing()).mockResolvedValueOnce(processing(true));
    mocks.complete.mockRejectedValueOnce(new Error("network lost after commit")).mockResolvedValueOnce(undefined);
    mocks.canonicalExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(svcSyncOfflineStation({ body: startBatch(), station, audit })).rejects.toThrow("network lost");
    const resumed = await svcSyncOfflineStation({ body: startBatch(), station, audit });
    expect(resumed.results[0]).toMatchObject({ status: "SYNCED", replayed: true });
    expect(mocks.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ idempotencyKey: "offline-start-000001" }));
  });

  it("rend les conflits explicites et persistants", async () => {
    mocks.start.mockRejectedValue(new HttpError(409, "PRODUCTION_EXECUTION_OVERLAP", "Chevauchement détecté."));
    const result = await svcSyncOfflineStation({ body: startBatch(), station, audit });
    expect(result.results[0]).toMatchObject({
      status: "REJECTED",
      code: "PRODUCTION_EXECUTION_OVERLAP",
      message: "Chevauchement détecté.",
    });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "REJECTED" }));
  });

  it("n'écrase jamais une collision d'identifiant ou de clé", async () => {
    mocks.reserve.mockResolvedValue({ kind: "CONFLICT" });
    const result = await svcSyncOfflineStation({ body: startBatch(), station, audit });
    expect(result.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_IDEMPOTENCY_CONFLICT" });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("exige l'identité exacte après réauthentification", async () => {
    const result = await svcSyncOfflineStation({ body: startBatch({ user_id: 8 }), station, audit });
    expect(result.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_OPERATOR_CONFLICT" });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("rejette explicitement une horloge trop en avance ou un événement expiré", async () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const ahead = await svcSyncOfflineStation({ body: startBatch({ occurred_at: future }), station, audit });
    const expired = await svcSyncOfflineStation({ body: startBatch({ occurred_at: old }), station, audit });
    expect(ahead.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_CLOCK_AHEAD" });
    expect(expired.results[0]).toMatchObject({ status: "REJECTED", code: "OFFLINE_EVENT_EXPIRED" });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("le kill switch ne consomme aucun événement", async () => {
    mocks.enabled.mockResolvedValue(false);
    const result = await svcSyncOfflineStation({ body: startBatch(), station, audit });
    expect(result).toMatchObject({ kill_switch_enabled: true, results: [] });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("refuse temporairement une synchronisation concurrente sans marquer l'événement rejeté", async () => {
    mocks.reserve.mockResolvedValue({ kind: "BUSY" });
    await expect(svcSyncOfflineStation({ body: startBatch(), station, audit })).rejects.toMatchObject({
      status: 503,
      code: "OFFLINE_EVENT_IN_PROGRESS",
    });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

describe("GPT56-FEAT-CERP-0006 — migration et frontières", () => {
  const patchDir = path.join(repoRoot, "db", "patches");
  const migration = fs.readFileSync(path.join(patchDir, "20260805_station_offline_queue_0006.sql"), "utf8");

  it("fournit migration, preflight, vérification et rollback test-only", () => {
    for (const suffix of ["preflight", "verify", "rollback"]) {
      expect(fs.existsSync(path.join(patchDir, "support", `20260805_station_offline_queue_0006.${suffix}.sql`))).toBe(true);
    }
    expect(migration.trimStart()).toMatch(/^--[\s\S]*?BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    const rollback = fs.readFileSync(path.join(patchDir, "support", "20260805_station_offline_queue_0006.rollback.sql"), "utf8");
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("offline receipt data exists");
  });

  it("ne crée ni effet stock/qualité ni secret persistant", () => {
    expect(migration).not.toMatch(/INSERT INTO public\.(stock_|lots|quality_|production_receipts)/i);
    expect(migration).not.toMatch(/\b(session_token|badge_uid|password|enrollment_secret)\s+(text|bytea)\b/i);
    expect(migration).toContain("POINTAGE_START");
    expect(migration).toContain("QUANTITY_DECLARE");
  });

  it("rend les reçus finaux immuables et fournit purge et kill switch", () => {
    expect(migration).toContain("Final offline receipts are immutable");
    expect(migration).toContain("fn_purge_production_station_offline_events");
    expect(migration).toContain("production_station_offline_config");
    expect(migration).toMatch(/GRANT SELECT ON TABLE public\.production_station_offline_config TO cerp_app/);
  });
});
