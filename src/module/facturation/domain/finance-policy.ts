import crypto from "node:crypto";

import { HttpError } from "../../../utils/httpError";

export const FACTURE_WORKFLOW_STATUSES = [
  "DRAFT",
  "PENDING_VALIDATION",
  "APPROVED",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "CANCELLED",
] as const;

export type FactureWorkflowStatus = (typeof FACTURE_WORKFLOW_STATUSES)[number];

export const AVOIR_WORKFLOW_STATUSES = [
  "DRAFT",
  "PENDING_VALIDATION",
  "APPROVED",
  "ISSUED",
  "CANCELLED",
] as const;

export type AvoirWorkflowStatus = (typeof AVOIR_WORKFLOW_STATUSES)[number];

export const PAYMENT_STATUSES = [
  "UNALLOCATED",
  "PARTIALLY_ALLOCATED",
  "ALLOCATED",
  "REJECTED",
  "REVERSED",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type FinanceCapability =
  | "read"
  | "draft_write"
  | "request_validation"
  | "validate"
  | "issue"
  | "credit_write"
  | "credit_issue"
  | "payment_register"
  | "payment_allocate"
  | "documents_read"
  | "audit_read"
  | "reporting_read"
  | "settings_manage";

const ROLES = {
  director: "Directeur",
  administrator: "Administrateur Systeme et Reseau",
  secretary: "Secretaire",
  accounting: "Comptabilite",
  accountant: "Comptable",
} as const;

const CAPABILITY_ROLES: Record<FinanceCapability, ReadonlySet<string>> = {
  read: new Set(Object.values(ROLES)),
  draft_write: new Set([ROLES.secretary, ROLES.accounting, ROLES.accountant, ROLES.director]),
  request_validation: new Set([ROLES.secretary, ROLES.accounting, ROLES.accountant, ROLES.director]),
  validate: new Set([ROLES.accounting, ROLES.accountant, ROLES.director]),
  issue: new Set([ROLES.accounting, ROLES.accountant, ROLES.director]),
  credit_write: new Set([ROLES.secretary, ROLES.accounting, ROLES.accountant, ROLES.director]),
  credit_issue: new Set([ROLES.accounting, ROLES.accountant, ROLES.director]),
  payment_register: new Set([ROLES.secretary, ROLES.accounting, ROLES.accountant, ROLES.director]),
  payment_allocate: new Set([ROLES.accounting, ROLES.accountant, ROLES.director]),
  documents_read: new Set(Object.values(ROLES)),
  audit_read: new Set([ROLES.accounting, ROLES.accountant, ROLES.director, ROLES.administrator]),
  reporting_read: new Set([ROLES.secretary, ROLES.accounting, ROLES.accountant, ROLES.director]),
  settings_manage: new Set([ROLES.director, ROLES.administrator]),
};

export function roleHasFinanceCapability(
  role: string | null | undefined,
  capability: FinanceCapability
): boolean {
  if (typeof role !== "string" || !role.trim()) return false;
  return CAPABILITY_ROLES[capability].has(role.trim());
}

const FACTURE_TRANSITIONS: Readonly<Record<FactureWorkflowStatus, readonly FactureWorkflowStatus[]>> = {
  DRAFT: ["PENDING_VALIDATION", "CANCELLED"],
  PENDING_VALIDATION: ["DRAFT", "APPROVED"],
  APPROVED: ["DRAFT", "ISSUED"],
  ISSUED: ["PARTIALLY_PAID", "PAID"],
  PARTIALLY_PAID: ["ISSUED", "PAID"],
  PAID: ["PARTIALLY_PAID"],
  CANCELLED: [],
};

const AVOIR_TRANSITIONS: Readonly<Record<AvoirWorkflowStatus, readonly AvoirWorkflowStatus[]>> = {
  DRAFT: ["PENDING_VALIDATION", "CANCELLED"],
  PENDING_VALIDATION: ["DRAFT", "APPROVED"],
  APPROVED: ["DRAFT", "ISSUED"],
  ISSUED: [],
  CANCELLED: [],
};

export function assertFactureTransition(
  current: FactureWorkflowStatus,
  target: FactureWorkflowStatus
): void {
  if (!FACTURE_TRANSITIONS[current]?.includes(target)) {
    throw new HttpError(
      409,
      "FACTURE_TRANSITION_FORBIDDEN",
      `Transition de facture interdite: ${current} vers ${target}.`
    );
  }
}

export function assertAvoirTransition(
  current: AvoirWorkflowStatus,
  target: AvoirWorkflowStatus
): void {
  if (!AVOIR_TRANSITIONS[current]?.includes(target)) {
    throw new HttpError(
      409,
      "AVOIR_TRANSITION_FORBIDDEN",
      `Transition d'avoir interdite: ${current} vers ${target}.`
    );
  }
}

export function assertSeparationOfDuties(params: {
  creatorUserId: number | null;
  validatorUserId: number;
}): void {
  if (params.creatorUserId !== null && params.creatorUserId === params.validatorUserId) {
    throw new HttpError(
      403,
      "FINANCE_SEPARATION_OF_DUTIES",
      "Le créateur ne peut pas valider son propre document financier."
    );
  }
}

export function normalizeIdempotencyKey(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (normalized.length < 8 || normalized.length > 200) {
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key doit contenir entre 8 et 200 caractères."
    );
  }
  return normalized;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function financeRequestHash(commandType: string, payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson({ command_type: commandType, payload }))
    .digest("hex");
}

export function financePreviewHash(payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function decideReceipt(
  existingHash: string | null | undefined,
  incomingHash: string
): "NEW" | "REPLAY" | "CONFLICT" {
  if (!existingHash) return "NEW";
  return existingHash === incomingHash ? "REPLAY" : "CONFLICT";
}

export function invoiceStatusFromBalance(params: {
  totalCents: bigint;
  settledCents: bigint;
}): "ISSUED" | "PARTIALLY_PAID" | "PAID" {
  if (params.settledCents <= 0n) return "ISSUED";
  if (params.settledCents < params.totalCents) return "PARTIALLY_PAID";
  return "PAID";
}

export function paymentStatusFromAllocation(params: {
  paymentCents: bigint;
  allocatedCents: bigint;
}): PaymentStatus {
  if (params.allocatedCents <= 0n) return "UNALLOCATED";
  if (params.allocatedCents < params.paymentCents) return "PARTIALLY_ALLOCATED";
  return "ALLOCATED";
}
