import { createHash } from "node:crypto";
import { z } from "zod";
/** Pure contract: persistence, outbox/inbox and cross-database atomicity are future work. */
const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
const ref = z.string().trim().min(1).max(128);
const decimal = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
export function decimalToMicros(v: string): bigint {
  const [w, f = ""] = decimal.parse(v).split(".");
  return BigInt(w) * 1000000n + BigInt(f.padEnd(6, "0"));
}
const positiveDecimal = decimal.refine((v) => decimalToMicros(v) > 0n);
const money = z
  .object({
    amount: decimal,
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
    source: z.literal("CAPTURED"),
  })
  .strict();
const company = z
  .object({
    company_id: uuid,
    namespace: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(64)
      .regex(/^[A-Z0-9_-]+$/),
    active: z.literal(true),
  })
  .strict();
const snapshot = z
  .object({
    product_label: z.string().trim().min(1).max(240),
    options: z
      .record(
        z.string().trim().min(1).max(80),
        z.union([
          z.string().max(500),
          z.boolean(),
          z.null(),
          z.number().finite(),
        ]),
      )
      .refine(
        (options) => Object.keys(options).length <= 100,
        "Too many commercial options",
      ),
  })
  .strict();
const line = z
  .object({
    source_sales_order_line_ref: ref,
    commercial_article_ref: ref,
    technical_supplier_reference: z
      .object({ piece_technique_id: uuid, piece_technique_version_id: uuid })
      .strict(),
    quantity: positiveDecimal,
    commercial_variant_snapshot: snapshot,
    ec_sale_unit_price: money,
    supplier_purchase_unit_price: money,
  })
  .strict();
export const intercompanyPurchaseOrderInputSchema = z
  .object({
    request_id: uuid,
    environment: z.enum(["cerp_prod", "cerp_test"]),
    revision: z.number().int().min(1).max(2147483647),
    buyer: company,
    supplier: company,
    relation: z
      .object({
        buyer_company_id: uuid,
        supplier_company_id: uuid,
        active: z.literal(true),
        supplier_configured: z.literal(true),
      })
      .strict(),
    source_purchase_order_ref: ref,
    source_sales_order_ref: ref,
    final_delivery_address: z
      .object({
        recipient_name: z.string().trim().min(1).max(180),
        address_line_1: z.string().trim().min(1).max(180),
        address_line_2: z.string().trim().max(180).optional(),
        postal_code: z.string().trim().min(1).max(24),
        city: z.string().trim().min(1).max(120),
        country_code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{2}$/),
      })
      .strict(),
    commercial_document_issuer_company_id: uuid,
    lines: z.array(line).min(1).max(500),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.buyer.company_id === v.supplier.company_id ||
      v.relation.buyer_company_id !== v.buyer.company_id ||
      v.relation.supplier_company_id !== v.supplier.company_id ||
      v.commercial_document_issuer_company_id !== v.buyer.company_id
    )
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid company relationship or commercial issuer",
      });
    if (
      new Set(v.lines.map((x) => x.source_sales_order_line_ref)).size !==
      v.lines.length
    )
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate source sales order line",
      });
  });
export type IntercompanyPurchaseOrderInput = z.infer<
  typeof intercompanyPurchaseOrderInputSchema
>;
export const INTERCOMPANY_ORDER_STATES = [
  "PENDING_SUPPLIER_APPROVAL",
  "ACCEPTED",
  "REJECTED",
  "CANCEL_REQUESTED",
  "CANCELLATION_REJECTED",
  "CANCELLED",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
] as const;
export type IntercompanyOrderState = (typeof INTERCOMPANY_ORDER_STATES)[number];
export type SupplierShipmentReceipt = Readonly<{
  shipment_id: string;
  idempotency_key: string;
  command_sha256: string;
  quantities_by_source_line: Readonly<Record<string, string>>;
}>;
export type IntercompanyOrder = Readonly<
  IntercompanyPurchaseOrderInput & {
    state: IntercompanyOrderState;
    immutable_payload_sha256: string;
    requested_fulfilment_by_line: Readonly<Record<string, string>>;
    fulfilled_quantities_by_line: Readonly<Record<string, string>>;
    supplier_shipments: readonly SupplierShipmentReceipt[];
  }
>;
function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string")
    return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Non-finite JSON value");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  throw new Error("Only plain JSON values are supported");
}
export function sha256Canonical(v: unknown): string {
  return createHash("sha256").update(canonical(v), "utf8").digest("hex");
}
function freeze<T>(v: T): Readonly<T> {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) freeze(x);
  }
  return v as Readonly<T>;
}
export function createIntercompanyPurchaseOrder(
  raw: unknown,
): IntercompanyOrder {
  const input = structuredClone(
    intercompanyPurchaseOrderInputSchema.parse(raw),
  );
  return freeze({
    ...input,
    state: "PENDING_SUPPLIER_APPROVAL",
    immutable_payload_sha256: sha256Canonical(input),
    requested_fulfilment_by_line: Object.fromEntries(
      input.lines.map((x) => [x.source_sales_order_line_ref, x.quantity]),
    ),
    fulfilled_quantities_by_line: {},
    supplier_shipments: [],
  });
}
export const intercompanyDecisionSchema = z
  .object({
    action: z.enum([
      "ACCEPT",
      "REJECT",
      "REQUEST_CANCEL",
      "CONFIRM_CANCEL",
      "REJECT_CANCEL",
    ]),
    actor_company_id: uuid,
    idempotency_key: z.string().trim().min(16).max(200),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export type IntercompanyDecision = z.infer<typeof intercompanyDecisionSchema>;
export type SupplierCustomerOrderIntent = Readonly<{
  type: "CREATE_SUPPLIER_CUSTOMER_ORDER";
  idempotency_key: string;
  request_id: string;
  revision: number;
  customer_company_id: string;
  customer_company_namespace: string;
  customer_order_owner_company_id: string;
  fulfilment_company_id: string;
  commercial_document_issuer_company_id: string;
  source_purchase_order_ref: string;
  final_delivery_address: IntercompanyPurchaseOrderInput["final_delivery_address"];
  supplier_purchase_lines: readonly Readonly<{
    source_sales_order_line_ref: string;
    commercial_article_ref: string;
    quantity: string;
    technical_supplier_reference: {
      piece_technique_id: string;
      piece_technique_version_id: string;
    };
    commercial_variant_snapshot: z.infer<typeof snapshot>;
    supplier_purchase_unit_price: z.infer<typeof money>;
  }>[];
}>;
export type IntercompanyDecisionResult = Readonly<{
  order: IntercompanyOrder;
  idempotent_replay: boolean;
  intent?: SupplierCustomerOrderIntent;
}>;
export type IntercompanyDecisionReceipt = Readonly<{
  idempotency_key: string;
  command_sha256: string;
  resulting_state: IntercompanyOrderState;
}>;
export function supplierCustomerOrderIntentKey(
  o: Pick<
    IntercompanyOrder,
    "environment" | "buyer" | "supplier" | "source_purchase_order_ref"
  >,
): string {
  return `intercompany:${o.environment}:${o.buyer.company_id}:${o.supplier.company_id}:${o.source_purchase_order_ref}:supplier-customer-order`;
}
export function intercompanyDecisionCommandHash(
  o: Pick<
    IntercompanyOrder,
    "request_id" | "revision" | "immutable_payload_sha256"
  >,
  d: IntercompanyDecision,
): string {
  return sha256Canonical({
    request_id: o.request_id,
    revision: o.revision,
    immutable_payload_sha256: o.immutable_payload_sha256,
    decision: d,
  });
}
export function resolveIntercompanyDecisionIdempotency(
  o: Pick<
    IntercompanyOrder,
    "request_id" | "revision" | "immutable_payload_sha256"
  >,
  raw: unknown,
  receipt: IntercompanyDecisionReceipt | null,
) {
  const d = intercompanyDecisionSchema.parse(raw);
  const command_sha256 = intercompanyDecisionCommandHash(o, d);
  return !receipt || receipt.idempotency_key !== d.idempotency_key
    ? { replay: false, conflict: false, command_sha256 }
    : {
        replay: receipt.command_sha256 === command_sha256,
        conflict: receipt.command_sha256 !== command_sha256,
        command_sha256,
      };
}
function intent(o: IntercompanyOrder): SupplierCustomerOrderIntent {
  return freeze({
    type: "CREATE_SUPPLIER_CUSTOMER_ORDER",
    idempotency_key: supplierCustomerOrderIntentKey(o),
    request_id: o.request_id,
    revision: o.revision,
    customer_company_id: o.buyer.company_id,
    customer_company_namespace: o.buyer.namespace,
    customer_order_owner_company_id: o.supplier.company_id,
    fulfilment_company_id: o.supplier.company_id,
    commercial_document_issuer_company_id: o.buyer.company_id,
    source_purchase_order_ref: o.source_purchase_order_ref,
    final_delivery_address: o.final_delivery_address,
    supplier_purchase_lines: o.lines.map(
      ({
        source_sales_order_line_ref,
        commercial_article_ref,
        quantity,
        technical_supplier_reference,
        commercial_variant_snapshot,
        supplier_purchase_unit_price,
      }) => ({
        source_sales_order_line_ref,
        commercial_article_ref,
        quantity,
        technical_supplier_reference,
        commercial_variant_snapshot,
        supplier_purchase_unit_price,
      }),
    ),
  });
}
export function decideIntercompanyOrder(
  o: IntercompanyOrder,
  raw: unknown,
): IntercompanyDecisionResult {
  const d = intercompanyDecisionSchema.parse(raw);
  let state: IntercompanyOrderState | undefined;
  let i: SupplierCustomerOrderIntent | undefined;
  if (
    d.action === "ACCEPT" &&
    d.actor_company_id === o.supplier.company_id &&
    o.state === "PENDING_SUPPLIER_APPROVAL"
  ) {
    state = "ACCEPTED";
    i = intent(o);
  } else if (
    d.action === "REJECT" &&
    d.actor_company_id === o.supplier.company_id &&
    o.state === "PENDING_SUPPLIER_APPROVAL" &&
    d.reason
  )
    state = "REJECTED";
  else if (
    d.action === "REQUEST_CANCEL" &&
    d.actor_company_id === o.buyer.company_id &&
    o.state === "PENDING_SUPPLIER_APPROVAL"
  )
    state = "CANCELLED";
  else if (
    d.action === "REQUEST_CANCEL" &&
    d.actor_company_id === o.buyer.company_id &&
    ["ACCEPTED", "PARTIALLY_FULFILLED", "CANCELLATION_REJECTED"].includes(
      o.state,
    ) &&
    d.reason
  )
    state = "CANCEL_REQUESTED";
  else if (
    d.action === "CONFIRM_CANCEL" &&
    d.actor_company_id === o.supplier.company_id &&
    o.state === "CANCEL_REQUESTED"
  )
    state = "CANCELLED";
  else if (
    d.action === "REJECT_CANCEL" &&
    d.actor_company_id === o.supplier.company_id &&
    o.state === "CANCEL_REQUESTED" &&
    d.reason
  )
    state = "CANCELLATION_REJECTED";
  if (!state) throw new Error("INTERCOMPANY_DECISION_NOT_ALLOWED");
  return freeze({
    order: freeze({ ...o, state }),
    idempotent_replay: false,
    ...(i ? { intent: i } : {}),
  });
}
export function receiptForIntercompanyDecision(
  o: IntercompanyOrder,
  raw: unknown,
  result: IntercompanyDecisionResult,
): IntercompanyDecisionReceipt {
  const d = intercompanyDecisionSchema.parse(raw);
  return freeze({
    idempotency_key: d.idempotency_key,
    command_sha256: intercompanyDecisionCommandHash(o, d),
    resulting_state: result.order.state,
  });
}
export const intercompanyFulfilmentSchema = z
  .object({
    shipment_id: ref,
    idempotency_key: z.string().trim().min(16).max(200),
    actor_company_id: uuid,
    quantities_by_source_line: z
      .record(ref, positiveDecimal)
      .refine((x) => Object.keys(x).length > 0),
  })
  .strict();
const asDecimal = (v: bigint) => {
  const w = v / 1000000n;
  const f = (v % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : w.toString();
};

function ownQuantity(
  record: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

export function applySupplierFulfilment(
  o: IntercompanyOrder,
  raw: unknown,
): IntercompanyOrder {
  const s = intercompanyFulfilmentSchema.parse(raw);
  if (s.actor_company_id !== o.supplier.company_id)
    throw new Error("INTERCOMPANY_FULFILMENT_NOT_ALLOWED");
  const command_sha256 = sha256Canonical({
    immutable_payload_sha256: o.immutable_payload_sha256,
    shipment: s,
  });
  const prior = o.supplier_shipments.find(
    (x) =>
      x.shipment_id === s.shipment_id ||
      x.idempotency_key === s.idempotency_key,
  );
  if (prior) {
    if (prior.command_sha256 === command_sha256) return o;
    throw new Error("INTERCOMPANY_FULFILMENT_IDEMPOTENCY_CONFLICT");
  }
  if (
    !["ACCEPTED", "PARTIALLY_FULFILLED", "CANCELLATION_REJECTED"].includes(
      o.state,
    )
  )
    throw new Error("INTERCOMPANY_FULFILMENT_NOT_ALLOWED");
  const fulfilled = { ...o.fulfilled_quantities_by_line };
  for (const [key, delta] of Object.entries(s.quantities_by_source_line)) {
    const requested = ownQuantity(o.requested_fulfilment_by_line, key);
    if (!requested) throw new Error("INTERCOMPANY_UNKNOWN_FULFILMENT_LINE");
    const next =
      decimalToMicros(ownQuantity(fulfilled, key) ?? "0") +
      decimalToMicros(delta);
    if (next > decimalToMicros(requested))
      throw new Error("INTERCOMPANY_OVER_FULFILMENT");
    Object.defineProperty(fulfilled, key, {
      value: asDecimal(next),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const complete = Object.entries(o.requested_fulfilment_by_line).every(
    ([k, v]) =>
      decimalToMicros(ownQuantity(fulfilled, k) ?? "0") === decimalToMicros(v),
  );
  return freeze({
    ...o,
    state: complete ? "FULFILLED" : "PARTIALLY_FULFILLED",
    fulfilled_quantities_by_line: fulfilled,
    supplier_shipments: [
      ...o.supplier_shipments,
      freeze({
        shipment_id: s.shipment_id,
        idempotency_key: s.idempotency_key,
        command_sha256,
        quantities_by_source_line: structuredClone(s.quantities_by_source_line),
      }),
    ],
  });
}
