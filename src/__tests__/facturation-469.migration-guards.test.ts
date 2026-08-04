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
const original227Patch = readFileSync(
  resolve(repoRoot, "db/patches/20260725_facturation_payments_227.sql"),
  "utf8"
);
const correctedChild227Patch = readFileSync(
  resolve(repoRoot, "db/patches/20260726_fix_facturation_child_trigger_227.sql"),
  "utf8"
);

function sqlFunction(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
  if (start < 0) throw new Error(`Missing SQL function ${name}`);
  const end = source.indexOf("$$;", start);
  if (end < 0) throw new Error(`Unterminated SQL function ${name}`);
  return source.slice(start, end + 3);
}

function normalizedSql(source: string): string {
  return source
    .replace(/--.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("#469 settlement-state guards", () => {
  it("preserves historical statuses and constrains future writes", () => {
    expect(patch).toContain("Historical `statut` values are never rewritten");
    expect(patch).toContain("facture_statut_469_ck");
    expect(patch).toContain("avoir_statut_469_ck");
    expect(patch).toMatch(/facture_statut_469_ck[\s\S]*NOT VALID/);
    expect(patch).toContain("'brouillon','emis','emise','envoyee','partielle','payee','annule','annulee'");
    expect(patch).not.toMatch(/UPDATE\s+public\.facture\s+SET\s+statut/i);
  });

  it("never derives settlement from legacy raw status without monetary evidence", () => {
    const settlementBackfill = patch.slice(
      patch.indexOf("settlement_status = CASE"),
      patch.indexOf("FROM (", patch.indexOf("settlement_status = CASE"))
    );
    expect(settlementBackfill).toContain("WHEN balance.settled_ttc > 0 THEN 'PARTIALLY_PAID'");
    expect(settlementBackfill).toContain("ELSE 'UNPAID'");
    expect(settlementBackfill).not.toContain("payee");
    expect(settlementBackfill).not.toContain("partielle");
    expect(supportScripts[1]).not.toMatch(
      /WHEN\s+(?:f\.)?statut\s*=\s*'(?:PAID|PARTIALLY_PAID)'\s+OR/i
    );
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

  it("uses the same net-payment predicate in migration, verification and reads", () => {
    for (const source of [patch, supportScripts[0], supportScripts[1], repository, factureRepository]) {
      expect(source).toContain("status NOT IN ('REJECTED','REVERSED')");
      expect(source).toContain("workflow_status <> 'REVERSED'");
      expect(source).toContain("reversal_of_id IS NULL");
    }
    expect(repository).toContain(
      "JOIN public.paiement allocated_payment ON allocated_payment.id = pa.paiement_id"
    );
  });

  it("hardens database allocation caps and direct legacy payment evidence", () => {
    expect(patch).toContain("CREATE OR REPLACE FUNCTION public.fn_validate_facturation_allocation_227()");
    expect(patch).toContain("direct legacy payment evidence cannot be converted to allocations");
    expect(patch).toContain("p.id <> NEW.paiement_id");
    expect(patch).toContain("asa.allocation_status = 'CONSUMED'");
    expect(patch).toMatch(
      /CREATE TRIGGER trg_validate_avoir_allocation_227\s+BEFORE INSERT OR UPDATE/i
    );
    expect(patch).toContain("direct legacy payment evidence cannot be deleted");
    expect(patch).toContain("NEW.status IS DISTINCT FROM OLD.status");
    expect(patch).toContain("NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id");
    expect(patch).toContain("incoming_invoice_credit := CASE");
    expect(patch).toContain("WHEN NEW.allocation_status = 'CONSUMED' THEN NEW.amount_ttc");
  });

  it("allows only monotone due-date settlement updates on issued legacy invoices", () => {
    expect(patch).toContain("CREATE OR REPLACE FUNCTION public.fn_protect_facturation_child_227()");
    expect(patch).toContain("parent_document_status = 'ISSUED'");
    expect(patch).toContain("NEW.amount_allocated >= OLD.amount_allocated");
    expect(patch).toContain("NEW.amount_allocated <= NEW.amount_due");
    expect(patch).toContain("to_jsonb(NEW) - 'amount_allocated' - 'status'");
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
    expect(rollback).toContain("CREATE OR REPLACE FUNCTION public.fn_validate_facturation_allocation_227()");
    expect(rollback).toContain("CREATE OR REPLACE FUNCTION public.fn_protect_paiement_227()");
    expect(rollback).toContain("CREATE OR REPLACE FUNCTION public.fn_protect_facturation_child_227()");
    expect(rollback).toMatch(
      /CREATE TRIGGER trg_validate_avoir_allocation_227 BEFORE INSERT ON public\.avoir_source_allocations/i
    );
    expect(rollback).not.toContain("direct legacy payment evidence cannot be deleted");
    expect(verify).toContain("pg_get_functiondef");
    expect(verify).toContain("pg_get_triggerdef");
  });

  it("restores the prior #227 function and trigger contracts on rollback", () => {
    const rollback = supportScripts[2];
    expect(normalizedSql(sqlFunction(
      rollback,
      "fn_validate_facturation_allocation_227"
    ))).toBe(normalizedSql(sqlFunction(
      original227Patch,
      "fn_validate_facturation_allocation_227"
    )));
    expect(normalizedSql(sqlFunction(
      rollback,
      "fn_protect_paiement_227"
    ))).toBe(normalizedSql(sqlFunction(
      original227Patch,
      "fn_protect_paiement_227"
    )));
    expect(normalizedSql(sqlFunction(
      rollback,
      "fn_protect_facturation_child_227"
    ))).toBe(normalizedSql(sqlFunction(
      correctedChild227Patch,
      "fn_protect_facturation_child_227"
    )));
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
