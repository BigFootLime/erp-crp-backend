import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoPath } from "../../../__tests__/helpers/repo-paths";
import type { CutoverAccess } from "../types/data-cutover.types";

// This verifies the repository boundary against the explicitly named disposable
// preparation database. It is opt-in so ordinary test runs never open a DB.
const url = process.env.CERP_CUTOVER_INTEGRATION_URL;
const describePg = url ? describe : describe.skip;
const superadmin: CutoverAccess = { userId: 1, isSuperadmin: true };
const assignedWipContributor: CutoverAccess = { userId: 2, isSuperadmin: false };
const unassignedContributor: CutoverAccess = { userId: 3, isSuperadmin: false };

let db: Pool;
let appPool: Pool;
let repository: typeof import("./data-cutover.repository");
let batchId: string;
let wipRowId: string;
let nonWipRowId: string;

describePg("cutover WIP context PostgreSQL access boundary", () => {
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url) throw new Error("Cutover integration URL must exactly match DATABASE_URL");
    const parsed = new URL(url);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.port !== "55471" || parsed.pathname !== "/cerp_cutover_1710") {
      throw new Error("Refusing non-disposable cutover test database");
    }
    db = new Pool({ connectionString: url });
    const identity = await db.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== "cerp_cutover_1710") throw new Error("Unexpected database identity");
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.users(id integer PRIMARY KEY,username text NOT NULL);
      ALTER TABLE public.users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Active';
      INSERT INTO public.users(id,username,status) VALUES(1,'wip-admin','Active'),(2,'wip-contributor','Active'),(3,'wip-outsider','Active') ON CONFLICT(id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS public.units(code text PRIMARY KEY,label text NOT NULL);
      INSERT INTO public.units(code,label) VALUES('u','Pièce') ON CONFLICT(code) DO NOTHING;
    `);
    await db.query(readFileSync(repoPath("db", "patches", "20261020_01_data_cutover_preparation_1710.sql"), "utf8"));
    repository = await import("./data-cutover.repository");
    appPool = (await import("../../../config/database")).default;

    batchId = crypto.randomUUID();
    wipRowId = crypto.randomUUID();
    nonWipRowId = crypto.randomUUID();
    await db.query(
      "INSERT INTO public.data_cutover_batches(id,name,source_system,source_hash,sources,created_by) VALUES($1::uuid,$2,'CLIPPER_EXCEL',$3,'[]'::jsonb,1)",
      [batchId, `WIP boundary ${batchId}`, crypto.randomBytes(32).toString("hex")],
    );
    for (const [id, domain, key] of [[wipRowId, "WIP", "WIP-private"], [nonWipRowId, "OPENING_STOCK", "STOCK-private"]] as const) {
      await db.query(
        `INSERT INTO public.data_cutover_rows(id,batch_id,domain,legacy_key,source_id,sheet,row_number,source_values,"values",updated_by)
         VALUES($1::uuid,$2::uuid,$3,$4,'fixture','private',1,'{}'::jsonb,'{}'::jsonb,1)`,
        [id, batchId, domain, key],
      );
    }
    await db.query("INSERT INTO public.data_cutover_contributors(batch_id,user_id,domain,assigned_by) VALUES($1::uuid,2,'WIP',1)", [batchId]);
  });

  afterAll(async () => {
    if (db && batchId) {
      await db.query("DELETE FROM public.data_cutover_contributors WHERE batch_id=$1::uuid", [batchId]);
      await db.query("DELETE FROM public.data_cutover_rows WHERE batch_id=$1::uuid", [batchId]);
      await db.query("DELETE FROM public.data_cutover_batches WHERE id=$1::uuid", [batchId]);
    }
    await appPool?.end();
    await db?.end();
  });

  it("returns only the assigned WIP row, hides another domain/outsider, and refuses contributor mapping overrides", async () => {
    await expect(repository.repoGetCutoverWipContext(batchId, wipRowId, undefined, assignedWipContributor)).resolves.toMatchObject({ article_ready: false });
    await expect(repository.repoGetCutoverWipContext(batchId, nonWipRowId, undefined, assignedWipContributor)).rejects.toMatchObject({ status: 404, code: "CUTOVER_ROW_NOT_FOUND" });
    await expect(repository.repoGetCutoverWipContext(batchId, wipRowId, undefined, unassignedContributor)).rejects.toMatchObject({ status: 404 });
    await expect(repository.repoGetCutoverWipContext(batchId, wipRowId, crypto.randomUUID(), assignedWipContributor)).rejects.toMatchObject({ status: 403, code: "CUTOVER_SUPERADMIN_MAPPING_REQUIRED" });
    await expect(repository.repoGetCutoverWipContext(batchId, wipRowId, undefined, assignedWipContributor, undefined, "42")).rejects.toMatchObject({ status: 403, code: "CUTOVER_SUPERADMIN_MAPPING_REQUIRED" });
    await expect(repository.repoGetCutoverWipContext(batchId, wipRowId, crypto.randomUUID(), superadmin)).resolves.toMatchObject({ article_ready: false });
    await expect(repository.repoGetCutoverWipContext(batchId, wipRowId, undefined, superadmin, undefined, "42")).resolves.toMatchObject({ article_ready: false });
  });
});
