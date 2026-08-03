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
  resolve(repoRoot, "src/module/facturation/repository/payment-workflow.repository.ts"),
  "utf8"
);

describe("#469 settlement-state guards", () => {
  it("preserves historical statuses and constrains future writes", () => {
    expect(patch).toContain("Historical `statut` values are never rewritten");
    expect(patch).toContain("facture_statut_469_ck");
    expect(patch).toContain("avoir_statut_469_ck");
    expect(patch).toMatch(/facture_statut_469_ck[\s\S]*NOT VALID/);
    expect(patch).not.toMatch(/UPDATE\s+public\.facture\s+SET\s+statut/i);
  });

  it("separates document and settlement state behind the immutable trigger", () => {
    expect(patch).toContain("document_status");
    expect(patch).toContain("settlement_status");
    expect(patch).toContain("cerp.finance_settlement_correlation_id");
    expect(patch).toContain("NEW.row_version = OLD.row_version + 1");
  });

  it("derives invoice state inside payment transactions and records evidence", () => {
    expect(repository).toContain("refreshInvoiceSettlementStates");
    expect(repository).toContain("FACTURE_SETTLEMENT_DERIVED");
    expect(repository).toContain("FINANCE-SETTLEMENT-469");
    expect(repository).toContain("FOR UPDATE");
    expect(repository).toContain("BEGIN");
    expect(repository).toContain("ROLLBACK");
  });

  it("restricts all database recipes to cerp_test", () => {
    for (const script of supportScripts) {
      expect(script).toContain("current_database() <> 'cerp_test'");
    }
  });
});
