import { createHash } from "node:crypto";
import { z } from "zod";

export const INTERCOMPANY_MESSAGE_KINDS = [
  "RELATION_PROPOSED", "RELATION_ACCEPTED",
  "CATALOGUE_PUBLISHED", "PURCHASE_SUBMITTED", "ORDER_DECIDED",
  "CANCEL_REQUESTED", "CANCELLATION_DECIDED", "SHIPMENT_DISPATCHED",
  "SUPPLIER_INVOICE_ISSUED",
] as const;
export type IntercompanyMessageKind = (typeof INTERCOMPANY_MESSAGE_KINDS)[number];
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
export const intercompanyMessageSchema = z.object({
  id: uuid,
  source_company_id: uuid,
  destination_company_id: uuid,
  environment: z.enum(["cerp_prod", "cerp_test"]),
  kind: z.enum(INTERCOMPANY_MESSAGE_KINDS),
  aggregate_id: z.string().trim().min(1).max(160),
  revision: z.number().int().positive().max(2147483647),
  occurred_at: z.string().datetime({ offset: true }),
  payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.record(z.string(), z.unknown()),
}).strict().superRefine((message, context) => {
  if (message.source_company_id === message.destination_company_id)
    context.addIssue({ code: "custom", message: "Intercompany participants must differ" });
});
export type IntercompanyMessage = z.infer<typeof intercompanyMessageSchema>;
export type IntercompanyMessageHandler = (
  tx: import("pg").PoolClient, message: IntercompanyMessage,
) => Promise<unknown>;

/** One JSON representation for message digests and authenticated delivery. */
export function canonicalIntercompanyJson(value: unknown, depth = 0): string {
  if (depth > 40) throw new Error("INTERCOMPANY_PAYLOAD_DEPTH_EXCEEDED");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalIntercompanyJson(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    // JSON object serialization omits optional properties whose value is
    // undefined. Apply the same rule before hashing; reject non-JSON values
    // elsewhere instead of signing bytes that cannot reach the receiver.
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalIntercompanyJson(record[key], depth + 1)}`).join(",")}}`;
  }
  throw new Error("INTERCOMPANY_PAYLOAD_NOT_JSON");
}
export function intercompanyDigest(value: unknown): string {
  return createHash("sha256").update(canonicalIntercompanyJson(value), "utf8").digest("hex");
}
export function parseIntercompanyMessage(input: unknown): IntercompanyMessage {
  const parsed = intercompanyMessageSchema.parse(input);
  if (Buffer.byteLength(canonicalIntercompanyJson(parsed), "utf8") > 1_000_000)
    throw new Error("INTERCOMPANY_MESSAGE_TOO_LARGE");
  if (intercompanyDigest(parsed.payload) !== parsed.payload_sha256)
    throw new Error("INTERCOMPANY_PAYLOAD_DIGEST_MISMATCH");
  return parsed;
}
