import { z } from "zod";
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const nativeId = z.string().regex(/^[1-9]\d{0,18}$/);
const text = z.string().trim().min(1).max(250);
export const intercompanyLegalSnapshotSchema = z.object({
  legal_name: text, registration_number: z.string().trim().max(100).optional(),
  vat_number: z.string().trim().max(100).optional(), address_lines: z.array(text).min(1).max(8),
  country_code: z.string().regex(/^[A-Z]{2}$/).optional(), issued_at: z.string().datetime({ offset: true }),
}).strict();
export const intercompanyDeliverySnapshotSchema = z.object({
  recipient_name: text, address_lines: z.array(text).min(1).max(8),
  address_line_1: text.optional(), address_line_2: z.string().trim().max(250).optional(),
  postal_code: z.string().trim().min(1).max(30).optional(), city: z.string().trim().min(1).max(120).optional(),
  country_code: z.string().regex(/^[A-Z]{2}$/).optional(),
  contact_name: z.string().trim().max(200).optional(), contact_phone: z.string().trim().max(60).optional(),
}).strict();
export const purchaseSubmittedPayloadSchema = z.object({
  schema_version: z.literal(1), relation_id: uuid,
  buyer_sales_order_id: nativeId, buyer_purchase_order_id: uuid,
  buyer_legal_snapshot: intercompanyLegalSnapshotSchema,
  final_delivery_address_snapshot: intercompanyDeliverySnapshotSchema,
  lines: z.array(z.object({
    buyer_sales_order_line_id: nativeId, buyer_purchase_order_line_id: uuid,
    catalogue_mapping_id: uuid, supplier_catalogue_mapping_id: uuid,
    mapping_version: z.number().int().positive(), supplier_mapping_version: z.number().int().positive(),
    supplier_article_id: uuid, supplier_piece_technique_id: uuid.nullish(),
    supplier_piece_technique_version_id: uuid.nullish(), supplier_reference: z.string().trim().max(160).nullish(),
    variant_code: z.string().trim().min(1).max(100),
    options_snapshot: z.record(z.string().max(80), z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()])).refine(v => Object.keys(v).length <= 100),
    quantity: z.number().finite().positive().max(1e9), unit: z.string().trim().min(1).max(30),
    purchase_unit_price: z.number().finite().min(0).max(1e12),
    purchase_vat_rate: z.number().finite().min(0).max(100), currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict()).min(1).max(200),
}).strict().superRefine((value, context) => {
  for (const key of ["buyer_sales_order_line_id", "buyer_purchase_order_line_id"] as const)
    if (new Set(value.lines.map(line => line[key])).size !== value.lines.length)
      context.addIssue({ code: "custom", path: ["lines"], message: "Duplicate source order line" });
  if (new Set(value.lines.map(line => line.currency)).size !== 1)
    context.addIssue({ code: "custom", path: ["lines"], message: "A purchase must have one currency" });
});
export type PurchaseSubmittedPayload = z.infer<typeof purchaseSubmittedPayloadSchema>;
