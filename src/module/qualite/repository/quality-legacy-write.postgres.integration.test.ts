import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockLegacyControlForWrite } from "./quality-legacy-write.repository";

const url = process.env.CERP_QUALITY_LEGACY_PG_URL;
const database = "quality_legacy_1137";
const enabled = Boolean(url && new URL(url).pathname === "/" + database);
const suite = enabled ? describe : describe.skip;
const legacyId = "00000000-0000-4000-8000-000000001137";
const frozenId = "00000000-0000-4000-8000-000000001138";
const planId = "00000000-0000-4000-8000-000000001139";

async function connect() {
  if (!enabled) throw new Error("Refusing a database outside the isolated #1137 fixture");
  const db = new Client({ connectionString: url });
  await db.connect();
  const { rows } = await db.query<{ name: string }>("SELECT current_database() AS name");
  if (rows[0]?.name !== database) { await db.end(); throw new Error("Refusing non-#1137 database"); }
  return db;
}

suite("#1137 legacy provenance guard — real isolated PostgreSQL", () => {
  beforeAll(async () => {
    const db = await connect();
    try {
      await db.query("CREATE TABLE quality_control (id uuid PRIMARY KEY, plan_id uuid, plan_snapshot_sha256 text)");
      await db.query("INSERT INTO quality_control VALUES ($1::uuid,NULL,NULL),($2::uuid,$3::uuid,$4)", [legacyId, frozenId, planId, "a".repeat(64)]);
    } finally { await db.end(); }
  });
  afterAll(async () => {
    const db = await connect();
    try { await db.query("DROP TABLE IF EXISTS quality_control"); } finally { await db.end(); }
  });
  it("rejects frozen controls and leaves their provenance unchanged after rollback", async () => {
    const db = await connect();
    try {
      await db.query("BEGIN");
      await expect(lockLegacyControlForWrite(db, frozenId)).rejects.toMatchObject({ status: 409, code: "QUALITY_CANONICAL_EXECUTION_REQUIRED" });
      await db.query("ROLLBACK");
      const { rows } = await db.query("SELECT plan_id,plan_snapshot_sha256 FROM quality_control WHERE id=$1::uuid", [frozenId]);
      expect(rows).toEqual([{ plan_id: planId, plan_snapshot_sha256: "a".repeat(64) }]);
    } finally { await db.end(); }
  });
  it("accepts genuine legacy provenance and returns false for absent controls", async () => {
    const db = await connect();
    try {
      await db.query("BEGIN");
      await expect(lockLegacyControlForWrite(db, legacyId)).resolves.toBe(true);
      await expect(lockLegacyControlForWrite(db, planId)).resolves.toBe(false);
      await db.query("ROLLBACK");
    } finally { await db.end(); }
  });
  it("holds the control row until transaction end, blocking concurrent writers", async () => {
    const first = await connect(), second = await connect();
    try {
      await first.query("BEGIN");
      await expect(lockLegacyControlForWrite(first, legacyId)).resolves.toBe(true);
      await second.query("BEGIN");
      await second.query("SET LOCAL statement_timeout = '150ms'");
      await expect(lockLegacyControlForWrite(second, legacyId)).rejects.toMatchObject({ code: "57014" });
      await second.query("ROLLBACK");
      await first.query("ROLLBACK");
      await second.query("BEGIN");
      await expect(lockLegacyControlForWrite(second, legacyId)).resolves.toBe(true);
      await second.query("ROLLBACK");
    } finally { await first.end(); await second.end(); }
  });
});
