import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/repo-paths";

const root = repoRoot;
const patch = readFileSync(
  resolve(root, "db/patches/20260725_facturation_payments_227.sql"),
  "utf8"
);
const preflight = readFileSync(
  resolve(root, "db/patches/support/20260725_facturation_payments_227.preflight.sql"),
  "utf8"
);
const verify = readFileSync(
  resolve(root, "db/patches/support/20260725_facturation_payments_227.verify.sql"),
  "utf8"
);
const rollback = readFileSync(
  resolve(root, "db/patches/support/20260725_facturation_payments_227.rollback.sql"),
  "utf8"
);

describe("#227 migration guards", () => {
  it("keeps the forward patch additive, transactional and inactive", () => {
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(patch).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(patch).not.toMatch(/\bINSERT\s+INTO\s+public\.finance_billing_policies\b/i);
    expect(patch).not.toMatch(/\bINSERT\s+INTO\s+public\.finance_legal_sequences\b/i);
  });

  it("protects issued documents, children, payments and evidence", () => {
    expect(patch).toContain("trg_protect_facture_immutable_227");
    expect(patch).toContain("trg_protect_avoir_immutable_227");
    expect(patch).toContain(
      "trg_protect_facture_source_227 BEFORE INSERT OR UPDATE OR DELETE"
    );
    expect(patch).toContain(
      "trg_protect_facture_echeance_227 BEFORE INSERT OR UPDATE OR DELETE"
    );
    expect(patch).toContain(
      "trg_protect_avoir_source_227 BEFORE INSERT OR UPDATE OR DELETE"
    );
    expect(patch).toContain("recorded payment identity and amount are immutable");
    expect(patch).toContain("facturation audit evidence is immutable");
  });

  it("enforces source, credit and payment allocation caps", () => {
    expect(patch).toContain("payment allocations exceed recorded payment");
    expect(patch).toContain("payment and credit allocations exceed invoice total");
    expect(patch).toContain(
      "invoice source allocations have a client mismatch or exceed delivered quantity"
    );
  });

  it("restricts every support script to cerp_test", () => {
    for (const script of [preflight, verify, rollback]) {
      expect(script).toContain("current_database() <> 'cerp_test'");
    }
    expect(rollback).toContain("#227 rollback refused: Finance evidence exists");
  });
});
