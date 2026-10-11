import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), marker: null as null | { plan_id: string | null; plan_snapshot_sha256: string | null } }));
vi.mock("../../../config/database", () => ({ default: { connect: async () => ({ query: fixture.query, release: fixture.release }) } }));

import { lockLegacyControlForWrite } from "./quality-legacy-write.repository";
import { repoPatchControl, repoValidateControl, type AuditContext } from "./qualite.repository";

const id = "00000000-0000-4000-8000-000000001137";
const audit: AuditContext = { user_id: 7, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };
const client = { query: fixture.query } as unknown as Pick<PoolClient, "query">;
const writes = () => fixture.query.mock.calls.filter(([sql]) => /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?\w/i.test(String(sql)));

beforeEach(() => {
  vi.resetAllMocks();
  fixture.marker = null;
  fixture.query.mockImplementation(async (sql: string) => {
    if (/SELECT plan_id, plan_snapshot_sha256/.test(sql)) return { rows: fixture.marker ? [fixture.marker] : [] };
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql.trim())) return { rows: [] };
    throw new Error("Unexpected query: " + sql);
  });
});

describe("#1137 canonical-plan controls cannot use historical writes", () => {
  const mutations = [
    ["patch", () => repoPatchControl({ id, audit, body: { note: "Fictive recipe", patch: { points: [] } } })],
    ["validate", () => repoValidateControl({ id, audit, body: { note: "Fictive recipe" } })],
  ] as const;
  for (const [name, mutation] of mutations) {
    it.each([
      { plan_id: id, plan_snapshot_sha256: "a".repeat(64) },
      { plan_id: id, plan_snapshot_sha256: null },
      { plan_id: null, plan_snapshot_sha256: "a".repeat(64) },
    ])(`${name} rejects frozen metadata and rolls back without any write: %j`, async marker => {
      fixture.marker = marker;
      await expect(mutation()).rejects.toMatchObject({ status: 409, code: "QUALITY_CANONICAL_EXECUTION_REQUIRED" });
      expect(fixture.query.mock.calls.map(([sql]) => String(sql).trim()).at(-1)).toBe("ROLLBACK");
      expect(writes()).toHaveLength(0);
      expect(fixture.query.mock.calls).toHaveLength(3);
      expect(fixture.release).toHaveBeenCalledOnce();
    });
    it(`${name} keeps a missing control absent without an audit or mutation`, async () => {
      await expect(mutation()).resolves.toBeNull();
      expect(writes()).toHaveLength(0);
      expect(fixture.query.mock.calls.map(([sql]) => String(sql).trim()).at(-1)).toBe("COMMIT");
    });
  }
  it("permits a genuine historical control while holding its row lock", async () => {
    fixture.marker = { plan_id: null, plan_snapshot_sha256: null };
    await expect(lockLegacyControlForWrite(client, id)).resolves.toBe(true);
    expect(fixture.query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), [id]);
    expect(writes()).toHaveLength(0);
  });
  it("propagates an unavailable database instead of treating it as a legacy control", async () => {
    fixture.query.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(lockLegacyControlForWrite(client, id)).rejects.toThrow("Database unavailable");
  });
});
