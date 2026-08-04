import { readFileSync } from "node:fs";
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
  getRealtimeControlPlaneMetrics,
  resetRealtimeControlPlaneMetrics,
} from "../shared/realtime/realtime-control-plane";

const patchPath = resolve(process.cwd(), "db/patches/20260804_realtime_shared_control_plane.sql");
const supportPath = resolve(process.cwd(), "db/patches/support");

function executableSql(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/'(?:''|[^'])*'/g, "''");
}

describe("shared realtime control plane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRealtimeControlPlaneMetrics();
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
            attemptedEventIds.push(String(params?.[0]));
            if (thisConnection < 3) throw Object.assign(new Error("temporary outage"), { code: "08006" });
            return {
              rows: [{
                sequence: "41",
                event_id: params?.[0],
                stream_id: "entity:OF:41",
                event_name: "lock:updated",
                payload: { locked: true },
                targets: [{ scope: "entity", entityType: "OF", entityId: "41" }],
                occurred_at: "2026-08-04T10:00:00.000Z",
              }],
            };
          }
          return { rows: [], rowCount: 0 };
        }),
      };
    });
    const controlPlane = new PostgresRealtimeControlPlane();

    const record = await controlPlane.publish({
      event: "lock:updated",
      payload: { locked: true },
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
        if (sql.includes("INSERT INTO public.realtime_event_log")) {
          throw Object.assign(new Error("invalid schema"), { code: "42P01" });
        }
        return { rows: [], rowCount: 0 };
      }),
    });
    const controlPlane = new PostgresRealtimeControlPlane();
    await expect(controlPlane.publish({
      event: "entity:changed",
      payload: {},
      targets: [{ scope: "module", moduleKey: "production" }],
      streamId: "rt:module:production",
    })).rejects.toThrow("invalid schema");
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(getRealtimeControlPlaneMetrics().publishFailures).toBe(1);
  });

  it("ships additive patch, read-only preflight/verify, and guarded rollback", () => {
    const patch = readFileSync(patchPath, "utf8");
    const preflight = readFileSync(resolve(supportPath, "20260804_realtime_shared_control_plane.preflight.sql"), "utf8");
    const verify = readFileSync(resolve(supportPath, "20260804_realtime_shared_control_plane.verify.sql"), "utf8");
    const rollback = readFileSync(resolve(supportPath, "20260804_realtime_shared_control_plane.rollback.sql"), "utf8");

    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.realtime_session_epochs");
    expect(patch).toContain("CREATE TABLE IF NOT EXISTS public.realtime_event_log");
    expect(patch).toContain("users_realtime_session_update_trg");
    expect(patch).toContain("user_role_assignments_realtime_session_trg");
    expect(patch).toContain("pg_notify");
    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY;");
    expect(verify).toContain("BEGIN TRANSACTION READ ONLY;");
    expect(executableSql(preflight)).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
    expect(executableSql(verify)).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("rollback refused");
  });
});
