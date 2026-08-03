import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/repo-paths";

const patch = readFileSync(
  resolve(repoRoot, "db/patches/20260804_finance_settlement_state_469.sql"),
  "utf8"
);
const supportScripts = ["preflight", "verify", "rollback"].map((suffix) =>
  readFileSync(
    resolve(repoRoot, `db/patches/support/20260804_finance_settlement_state_469.${suffix}.sql`),
    "utf8"
  )
);
const repository = readFileSync(
  resolve(repoRoot, "src/module/facturation/repository/invoice-settlement.repository.ts"),
  "utf8"
);
const paymentRepository = readFileSync(
  resolve(repoRoot, "src/module/facturation/repository/payment-workflow.repository.ts"),
  "utf8"
);
const creditRepository = readFileSync(
  resolve(repoRoot, "src/module/facturation/repository/avoir-workflow.repository.ts"),
  "utf8"
);
const factureRepository = readFileSync(
  resolve(repoRoot, "src/module/facturation/repository/factures.repository.ts"),
  "utf8"
);

describe("#469 settlement-state guards", () => {
  it("preserves historical statuses and constrains future writes", () => {
    expect(patch).toContain("Historical `statut` values are never rewritten");
    expect(patch).toContain("facture_statut_469_ck");
    expect(patch).toContain("avoir_statut_469_ck");
    expect(patch).toMatch(/facture_statut_469_ck[\s\S]*NOT VALID/);
    expect(patch).toContain("'brouillon','emis','emise','envoyee','partielle','payee','annule','annulee'");
    expect(patch).not.toMatch(/UPDATE\s+public\.facture\s+SET\s+statut/i);
  });

  it("separates document and settlement state behind the immutable trigger", () => {
    expect(patch).toContain("document_status");
    expect(patch).toContain("settlement_status");
    expect(patch).toContain("cerp.finance_settlement_correlation_id");
    expect(patch).toMatch(
      /current_setting\('cerp\.finance_settlement_correlation_id', true\) IS NOT NULL/
    );
    expect(patch).toMatch(
      /current_setting\('cerp\.finance_settlement_correlation_id', true\)\s*= NEW\.correlation_id::text/
    );
    expect(patch).toContain("NEW.row_version = OLD.row_version + 1");
    expect(patch).toContain("'emise', 'envoyee', 'partielle', 'payee', 'emis'");
  });

  it("derives invoice state inside payment transactions and records evidence", () => {
    expect(repository).toContain("refreshInvoiceSettlementStates");
    expect(repository).toContain("FACTURE_SETTLEMENT_DERIVED");
    expect(repository).toContain("FINANCE-SETTLEMENT-469");
    expect(repository).toContain("FOR UPDATE");
    expect(paymentRepository).toContain("BEGIN");
    expect(paymentRepository).toContain("ROLLBACK");
    expect(creditRepository).toContain("refreshInvoiceSettlementStates");
  });

  it("uses the legacy direct-evidence fallback without double counting", () => {
    for (const script of [patch, supportScripts[0], supportScripts[1]]) {
      expect(script).toContain("existing_pa.paiement_id = p.id");
      expect(script).toContain("existing_asa.avoir_id = a.id");
    }
    expect(repository).toContain("legacy_direct_payment_ttc");
    expect(repository).toContain("legacy_direct_credit_ttc");
  });

  it("asserts constraint definitions and protects a controlled non-test rollback", () => {
    const verify = supportScripts[1];
    const rollback = supportScripts[2];
    expect(verify).toContain("pg_get_constraintdef");
    expect(verify).toContain("convalidated = FALSE");
    expect(verify).toContain("convalidated = TRUE");
    expect(rollback).toContain("cerp.finance_469_application_rolled_back");
    expect(rollback).toContain("cerp.finance_469_rollback_authorized");
    expect(rollback).toContain("current_database() <> 'cerp_test'");
  });

  it("keeps invoice lines independent from payment aliases", () => {
    const lineQuery = factureRepository.slice(
      factureRepository.indexOf("const lignes: FactureLine[]"),
      factureRepository.indexOf("const documents: FactureDocument[]")
    );
    expect(lineQuery).not.toContain("paiement.id");
    expect(lineQuery).toContain("facture_id::text AS facture_id");
  });
});
