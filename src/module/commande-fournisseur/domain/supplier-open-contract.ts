import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import type { GeneralTermsSnapshot } from "../../../shared/commercial-terms/commercial-terms.domain";
import type { ConsultationTechnicalSource } from "./supplier-consultation";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const instant = Date.parse(`${value}T00:00:00Z`);
    return (
      Number.isFinite(instant) &&
      new Date(instant).toISOString().slice(0, 10) === value
    );
  }, "Date invalide.");
const quantity = z
  .number()
  .finite()
  .positive()
  .max(9_999_999)
  .refine(
    (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
    "Trois décimales au maximum.",
  );
const money = z
  .number()
  .finite()
  .min(0)
  .max(99_999_999)
  .refine(
    (value) => Math.abs(value * 10000 - Math.round(value * 10000)) < 0.00001,
    "Quatre décimales au maximum.",
  );
const envelope = z
  .object({ line_id: z.string().uuid(), limit: quantity, unit_price_ht: money })
  .strict();
const revision = {
  valid_from: date,
  valid_to: date,
  evidence_version_id: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
  envelopes: z.array(envelope).min(1).max(200),
  general_terms_version_id: z.string().uuid().optional(),
};
const base = {
  idempotency_key: z.string().uuid(),
  expected_updated_at: z.string().min(1).max(100),
};
export const supplierOpenContractCommandSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        ...base,
        action: z.literal("CREATE"),
        document_version_ids: z.array(z.string().uuid()).max(200).optional(),
        reference: z.string().trim().min(1).max(120),
        ...revision,
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("AMEND"),
        contract_id: z.string().uuid(),
        expected_revision_id: z.string().uuid(),
        ...revision,
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("ATTACH"),
        document_version_ids: z.array(z.string().uuid()).max(200).optional(),
        contract_id: z.string().uuid(),
        expected_revision_id: z.string().uuid(),
        mappings: z
          .array(
            z
              .object({
                line_id: z.string().uuid(),
                contract_line_id: z.string().uuid(),
              })
              .strict(),
          )
          .min(1)
          .max(200),
        reason: z.string().trim().min(3).max(500),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("CLOSE"),
        contract_id: z.string().uuid(),
        expected_revision_id: z.string().uuid(),
        reason: z.string().trim().min(3).max(500),
      })
      .strict(),
  ])
  .superRefine((input, ctx) => {
    if ("valid_from" in input && input.valid_to < input.valid_from)
      ctx.addIssue({
        code: "custom",
        path: ["valid_to"],
        message: "La fin doit suivre le début.",
      });
    const entries =
      "envelopes" in input
        ? input.envelopes
        : "mappings" in input
          ? input.mappings
          : [];
    if (new Set(entries.map((row) => row.line_id)).size !== entries.length)
      ctx.addIssue({
        code: "custom",
        path: ["envelopes" in input ? "envelopes" : "mappings"],
        message: "Une ligne ne peut apparaître qu’une fois.",
      });
  });
export type SupplierOpenContractCommand = z.infer<
  typeof supplierOpenContractCommandSchema
>;
export type ContractItem = {
  key: string;
  article_id: string;
  designation: string;
  type: string;
  unit: string;
  stock_unit: string | null;
  coefficient: number | null;
  limit: number;
  unit_price_ht: number;
  discount_pct: number;
  fees_ht: number;
  vat_pct: number;
  supplier_reference: string | null;
  requirements: unknown[];
  documents: string[];
};
export type ContractSnapshot = {
  currency: string;
  incoterm: string | null;
  payment_terms: string | null;
  transport_mode: string | null;
  general_terms: GeneralTermsSnapshot;
  items: ContractItem[];
};
export type ContractEvidence = Omit<GeneralTermsSnapshot, "kind">;
export type ContractRevision = {
  id: string;
  revision: number;
  valid_from: string;
  valid_to: string;
  snapshot: ContractSnapshot;
  evidence: ContractEvidence;
  reason: string;
  created_at: string;
};
export type ContractUsage = {
  key: string;
  reserved: number;
  ordered: number;
  received: number;
  committed: number;
  remaining: number;
};
export type ContractCall = {
  id: string;
  order_id: string;
  order_code: string;
  status: string;
  revision_id: string;
  created_at: string;
  technical_sources: ConsultationTechnicalSource[];
  documents: Array<{
    document_id: string;
    version_id: string;
    code: string;
    title: string;
    original_name: string;
    version_number: number;
    sha256: string;
  }>;
};
export function scaledQuantity(value: number): bigint {
  return BigInt(Math.round(value * 1000));
}
export function assertContractCapacity(
  limit: number,
  committed: number,
  additional: number,
): void {
  if (
    scaledQuantity(committed) + scaledQuantity(additional) >
    scaledQuantity(limit)
  )
    throw new HttpError(
      409,
      "OPEN_CONTRACT_CAPACITY_EXCEEDED",
      "L’appel dépasse la quantité encore disponible au contrat.",
      { limit, committed, additional },
    );
}
export function assertContractWindow(
  from: string,
  to: string,
  at: string,
  needDates: Array<string | null>,
): void {
  if (
    at < from ||
    at > to ||
    needDates.some((value) => value !== null && (value < from || value > to))
  )
    throw new HttpError(
      409,
      "OPEN_CONTRACT_OUTSIDE_PERIOD",
      "La date de l’appel ou de livraison sort de la période contractuelle. Enregistrez un avenant si nécessaire.",
    );
}
