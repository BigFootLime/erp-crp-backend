/* TEST-only runner for the additive #1454 line-domain patch on an owned fixture DB. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import db from "../../src/config/database";

async function main() {
  const identity = await db.query<{ database: string }>("SELECT current_database() AS database");
  const database = identity.rows[0]?.database ?? "";
  if (!/^cerp_ec1454_(buyer|seller)_v2$/.test(database)) throw new Error("TEST fixture database required");
  for (const name of [
    "20261027_zzz_intercompany_dropship_commande_ligne_1454.sql",
    "20261027_zzzz_intercompany_dropship_standard_invariants_1454.sql",
  ]) {
    await db.query(await readFile(resolve(__dirname, "../../db/patches", name), "utf8"));
  }
  process.stdout.write(`E2E_DROPSHIP_LINE_MIGRATION_PASS ${JSON.stringify({ database })}\n`);
}
main().catch(error => { process.stderr.write(`E2E_DROPSHIP_LINE_MIGRATION_FAIL ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }).finally(() => db.end());
