"use strict";

/** Exercise the real verifier against transactional metadata tampering in the
 * rehearsal's disposable database. Every case restores and rechecks the key. */
async function verifyStockValueUniqueness(client, verifySql, legacyShapeSql) {
  const database = await client.query("SELECT current_database() AS name");
  if (database.rows[0]?.name !== "cerp_test") throw new Error("Stock verifier tests require the disposable cerp_test database");
  const dropPosting = "ALTER TABLE public.stock_valuation_entries DROP CONSTRAINT stock_invoice_posting_unique_1022;";
  const dropIdentity = "ALTER TABLE public.stock_valuation_entries DROP CONSTRAINT stock_invoice_entry_identity_1022;";
  const cases = [
    ["missing posting key", dropPosting, "Physical/opening uniqueness must remain preserved"],
    ["predecessor key on successor schema", dropPosting + `ALTER TABLE public.stock_valuation_entries
      ADD CONSTRAINT stock_value_posting_unique_1007 UNIQUE NULLS NOT DISTINCT
      (movement_id,article_id,owner_key,stock_unit,currency,value_adjustment_id);`, "Physical/opening uniqueness must remain preserved"],
    ["same-size key with wrong columns", dropPosting + `ALTER TABLE public.stock_valuation_entries
      ADD CONSTRAINT stock_invoice_posting_unique_1022 UNIQUE NULLS NOT DISTINCT
      (movement_id,article_id,owner_key,stock_unit,kind,value_adjustment_id,invoice_reconciliation_id);`, "Physical/opening uniqueness must remain preserved"],
    ["NULLS DISTINCT posting key", dropPosting + `ALTER TABLE public.stock_valuation_entries
      ADD CONSTRAINT stock_invoice_posting_unique_1022 UNIQUE
      (movement_id,article_id,owner_key,stock_unit,currency,value_adjustment_id,invoice_reconciliation_id);`, "Physical/opening uniqueness must remain preserved"],
    ["missing correction identity", dropIdentity, "Physical/opening uniqueness requires the validated invoice correction identity"],
    ["weakened correction identity", dropIdentity + `ALTER TABLE public.stock_valuation_entries
      ADD CONSTRAINT stock_invoice_entry_identity_1022 CHECK ((kind='INVOICE_ADJUSTMENT') OR true);`, "Physical/opening uniqueness requires the validated invoice correction identity"],
    ["unvalidated correction identity", dropIdentity + `ALTER TABLE public.stock_valuation_entries
      ADD CONSTRAINT stock_invoice_entry_identity_1022
      CHECK ((kind='INVOICE_ADJUSTMENT')=(invoice_reconciliation_id IS NOT NULL)) NOT VALID;`, "Physical/opening uniqueness requires the validated invoice correction identity"],
  ];
  const results = [];
  // Run the actual documented shape rollback inside a test transaction. Its
  // archive tables/columns remain present; the six-column key must still pass.
  if (!legacyShapeSql) throw new Error("The documented invoice shape rollback is required");
  await client.query("BEGIN");
  try {
    await client.query(legacyShapeSql.replace(/^\s*(?:BEGIN|COMMIT);\s*$/gm, ""));
    await client.query(verifySql);
    const archives = await client.query("SELECT to_regclass('public.stock_valuation_invoice_reconciliations') IS NOT NULL AS retained");
    if (!archives.rows[0]?.retained) throw new Error("Documented shape rollback removed invoice proof archives");
  } finally {
    await client.query("ROLLBACK");
  }
  await client.query(verifySql);
  for (const [name, tamperSql, expectedMessage] of cases) {
    await client.query("BEGIN");
    try {
      await client.query(tamperSql);
      let rejection;
      try { await client.query(verifySql); } catch (error) { rejection = error; }
      if (rejection?.code !== "P0001" || !rejection.message.includes(expectedMessage)) {
        throw new Error(`Stock verifier failed to reject ${name}: ${rejection?.message ?? "accepted"}`);
      }
      results.push({ name, status: "rejected" });
    } finally {
      await client.query("ROLLBACK");
    }
    await client.query(verifySql);
  }
  return { database: "cerp_test", baseline: "passed", legacy_shape_with_archives: "passed", tampering_cases: results, restoration: "passed" };
}

module.exports = { verifyStockValueUniqueness };
