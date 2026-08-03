import { describe, expect, it } from "vitest";

import { HttpError } from "../../../utils/httpError";
import {
  assertAvoirTransition,
  assertFactureTransition,
  decideReceipt,
  financeRequestHash,
  invoiceSettlementStatusFromBalance,
  invoiceStatusFromBalance,
  paymentStatusFromAllocation,
  roleHasFinanceCapability,
} from "./finance-policy";

const factureStatuses = [
  "DRAFT",
  "PENDING_VALIDATION",
  "APPROVED",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "CANCELLED",
] as const;

const allowedFactureTransitions = new Set([
  "DRAFT:PENDING_VALIDATION",
  "DRAFT:CANCELLED",
  "PENDING_VALIDATION:DRAFT",
  "PENDING_VALIDATION:APPROVED",
  "APPROVED:DRAFT",
  "APPROVED:ISSUED",
  "ISSUED:PARTIALLY_PAID",
  "ISSUED:PAID",
  "PARTIALLY_PAID:ISSUED",
  "PARTIALLY_PAID:PAID",
  "PAID:PARTIALLY_PAID",
]);

describe("issue #227 — transitions facture", () => {
  it.each(
    factureStatuses.flatMap((from) =>
      factureStatuses.map((to, index) => ({
        id: `FIN-TR-${from}-${String(index + 1).padStart(2, "0")}`,
        from,
        to,
      }))
    )
  )("$id $from -> $to", ({ from, to }) => {
    const expected = allowedFactureTransitions.has(`${from}:${to}`);
    if (expected) {
      expect(() => assertFactureTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertFactureTransition(from, to)).toThrowError(HttpError);
    }
  });
});

const avoirStatuses = ["DRAFT", "PENDING_VALIDATION", "APPROVED", "ISSUED", "CANCELLED"] as const;
const allowedAvoirTransitions = new Set([
  "DRAFT:PENDING_VALIDATION",
  "DRAFT:CANCELLED",
  "PENDING_VALIDATION:DRAFT",
  "PENDING_VALIDATION:APPROVED",
  "APPROVED:DRAFT",
  "APPROVED:ISSUED",
]);

describe("issue #227 — transitions avoir", () => {
  it.each(
    avoirStatuses.flatMap((from) =>
      avoirStatuses.map((to, index) => ({
        id: `CRD-TR-${from}-${String(index + 1).padStart(2, "0")}`,
        from,
        to,
      }))
    )
  )("$id $from -> $to", ({ from, to }) => {
    const expected = allowedAvoirTransitions.has(`${from}:${to}`);
    if (expected) {
      expect(() => assertAvoirTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertAvoirTransition(from, to)).toThrowError(HttpError);
    }
  });
});

describe("issue #227 — RBAC fail-closed", () => {
  it.each([
    ["Secretaire", "draft_write", true],
    ["Secretaire", "issue", false],
    ["Comptabilite", "issue", true],
    ["Comptable", "payment_allocate", true],
    ["Directeur", "credit_issue", true],
    ["Administrateur Systeme et Reseau", "settings_manage", true],
    ["Administrateur Systeme et Reseau", "issue", true],
    ["Responsable Comptabilite", "issue", false],
    ["admin", "settings_manage", false],
    ["", "read", false],
  ] as const)("%s / %s", (role, capability, expected) => {
    expect(roleHasFinanceCapability(role, capability)).toBe(expected);
  });

  it.each([
    "read",
    "draft_write",
    "request_validation",
    "validate",
    "issue",
    "credit_write",
    "credit_issue",
    "payment_register",
    "payment_allocate",
    "documents_read",
    "audit_read",
    "reporting_read",
    "settings_manage",
  ] as const)("accorde la capacité %s à l'administrateur système", (capability) => {
    expect(roleHasFinanceCapability("Administrateur Systeme et Reseau", capability)).toBe(true);
  });
});

describe("issue #227 — idempotence et soldes", () => {
  it("stabilise le hash malgré l'ordre des propriétés", () => {
    expect(financeRequestHash("PAYMENT_REGISTER", { b: 2, a: 1 })).toBe(
      financeRequestHash("PAYMENT_REGISTER", { a: 1, b: 2 })
    );
  });

  it.each([
    [null, "abc", "NEW"],
    ["abc", "abc", "REPLAY"],
    ["abc", "def", "CONFLICT"],
  ] as const)("receipt %s/%s", (stored, incoming, expected) => {
    expect(decideReceipt(stored, incoming)).toBe(expected);
  });

  it.each([
    [10_000n, 0n, "ISSUED"],
    [10_000n, 1n, "PARTIALLY_PAID"],
    [10_000n, 9_999n, "PARTIALLY_PAID"],
    [10_000n, 10_000n, "PAID"],
  ] as const)("statut facture %s/%s", (totalCents, settledCents, expected) => {
    expect(invoiceStatusFromBalance({ totalCents, settledCents })).toBe(expected);
  });

  it.each([
    [10_000n, 0n, "UNPAID"],
    [10_000n, 1n, "PARTIALLY_PAID"],
    [10_000n, 9_999n, "PARTIALLY_PAID"],
    [10_000n, 10_000n, "PAID"],
  ] as const)("état de règlement facture %s/%s", (totalCents, settledCents, expected) => {
    expect(invoiceSettlementStatusFromBalance({ totalCents, settledCents })).toBe(expected);
  });

  it.each([
    [10_000n, 0n, "UNALLOCATED"],
    [10_000n, 1n, "PARTIALLY_ALLOCATED"],
    [10_000n, 9_999n, "PARTIALLY_ALLOCATED"],
    [10_000n, 10_000n, "ALLOCATED"],
  ] as const)("statut paiement %s/%s", (paymentCents, allocatedCents, expected) => {
    expect(paymentStatusFromAllocation({ paymentCents, allocatedCents })).toBe(expected);
  });
});
