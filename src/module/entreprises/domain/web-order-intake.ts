import { createHash } from "node:crypto";
import { z } from "zod";

// This is a server-side contract, not a public webhook or an authentication
// mechanism. A future adapter must verify its signature and load the registered
// connector before calling it. Company/environment never come from the event.
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const text = z.string().trim().min(1).max(200);
const externalId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\u0000-\u001f\u007f]+$/);

export const commercialCustomerIdentitySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("PROFESSIONAL"),
      legal_name: text,
    })
    .strict(),
  z
    .object({
      type: z.literal("INDIVIDUAL"),
      first_name: text,
      last_name: text,
    })
    .strict(),
]);

/** Membership of an ERP employee and identity of a shop customer are separate. */
export function commercialCustomerDisplayName(raw: unknown): string {
  const customer = commercialCustomerIdentitySchema.parse(raw);
  return customer.type === "PROFESSIONAL"
    ? customer.legal_name
    : `${customer.first_name} ${customer.last_name}`;
}

export const webOrderConnectorSchema = z
  .object({
    connector_id: uuid,
    environment: z.enum(["cerp_prod", "cerp_test"]),
    buyer_company_id: uuid,
    supplier_company_id: uuid,
    status: z.enum(["ACTIVE", "DISABLED"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.buyer_company_id === value.supplier_company_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Buyer and supplier must differ",
      });
    }
  });

// Decimal strings retain the shop's amounts. Tax, currency conversion and
// invoicing policy remain in the authoritative commercial/finance modules.
const quantity = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/)
  .refine((value) => /[1-9]/.test(value), "Quantity must be positive");
const amount = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/);
const address = z
  .object({
    recipient_name: text,
    address_line_1: text,
    address_line_2: text.optional(),
    postal_code: z.string().trim().min(1).max(24),
    city: text,
    country_code: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();

export const webOrderEventSchema = z
  .object({
    contract_version: z.literal(1),
    external_order_id: externalId,
    external_order_revision: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER),
    state: z.enum(["DRAFT", "CONFIRMED", "CANCELLED"]),
    confirmed_at: z.string().datetime({ offset: true }).optional(),
    customer: commercialCustomerIdentitySchema,
    delivery_address: address,
    lines: z
      .array(
        z
          .object({
            external_line_id: externalId,
            commercial_article_ref: externalId,
            // A binding is resolved server-side to an authorized supplier/version.
            catalogue_binding_id: uuid,
            catalogue_binding_revision: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
            quantity,
            sale_unit_price: z
              .object({ amount, currency: z.string().regex(/^[A-Z]{3}$/) })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "CONFIRMED" && !value.confirmed_at) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmed_at"],
        message: "Confirmation timestamp required",
      });
    }
    if (
      new Set(value.lines.map((line) => line.external_line_id)).size !==
      value.lines.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lines"],
        message: "Duplicate shop order line",
      });
    }
  });

export type WebOrderConnector = z.infer<typeof webOrderConnectorSchema>;
export type WebOrderEvent = z.infer<typeof webOrderEventSchema>;

function digest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const intakeReceiptSchema = z
  .object({
    source_key: z.string().regex(/^web-order:[a-f0-9]{64}$/),
    payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    external_order_revision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    state: z.enum(["DRAFT", "CONFIRMED", "CANCELLED"]),
    supplier_company_id: uuid,
    purchase_requested: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.state === "DRAFT" && value.purchase_requested) ||
      (value.state === "CONFIRMED" && !value.purchase_requested)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Inconsistent processed shop order state",
      });
    }
  });

export type WebOrderIntakeReceipt = Readonly<
  z.infer<typeof intakeReceiptSchema>
>;

/** Retained in EC only; never serialize this snapshot as a supplier message. */
export type EcShopOrderSnapshot = WebOrderEvent;
export type PurchaseOrderCreationIntent = Readonly<{
  type: "CREATE_PURCHASE_ORDER";
  idempotency_key: string;
  buyer_company_id: string;
  supplier_company_id: string;
  source_order_reference: string;
  manual_buyer_approval_required: false;
  supplier_approval_required: true;
}>;

/**
 * Returns intentions only. The EC order, receipt and purchase outbox must be
 * committed atomically by a future repository. Changed orders are amendments,
 * never a second purchase created merely because the shop revision increased.
 */
export function planWebOrderIntake(
  connectorRaw: unknown,
  eventRaw: unknown,
  previous?: WebOrderIntakeReceipt,
) {
  const connector = webOrderConnectorSchema.parse(connectorRaw);
  if (connector.status !== "ACTIVE")
    throw new Error("WEB_ORDER_CONNECTOR_DISABLED");
  const event = webOrderEventSchema.parse(eventRaw);
  const source_key = `web-order:${digest([
    connector.environment,
    connector.connector_id,
    connector.buyer_company_id,
    event.external_order_id,
  ])}`;
  const payload_sha256 = digest([connector, event]);
  const prior = previous ? intakeReceiptSchema.parse(previous) : undefined;
  if (prior) {
    if (prior.source_key !== source_key)
      throw new Error("WEB_ORDER_RECEIPT_SCOPE_MISMATCH");
    if (prior.supplier_company_id !== connector.supplier_company_id)
      throw new Error("WEB_ORDER_SUPPLIER_BINDING_CHANGED");
    if (event.external_order_revision < prior.external_order_revision)
      return freeze({ disposition: "STALE" as const, receipt: prior });
    if (event.external_order_revision === prior.external_order_revision) {
      if (prior.payload_sha256 !== payload_sha256)
        throw new Error("WEB_ORDER_REVISION_CONFLICT");
      return freeze({ disposition: "REPLAY" as const, receipt: prior });
    }
    if (prior.state === "CANCELLED" && event.state !== "CANCELLED")
      throw new Error("WEB_ORDER_TERMINAL_STATE");
    if (prior.purchase_requested && event.state === "DRAFT")
      throw new Error("WEB_ORDER_STATE_REGRESSION");
  }

  const receipt = freeze({
    source_key,
    payload_sha256,
    external_order_revision: event.external_order_revision,
    state: event.state,
    supplier_company_id: connector.supplier_company_id,
    purchase_requested:
      prior?.purchase_requested === true || event.state === "CONFIRMED",
  });
  if (event.state !== "CONFIRMED") {
    return freeze({
      disposition: receipt.purchase_requested
        ? ("CANCELLATION_REQUIRED" as const)
        : ("NO_PURCHASE" as const),
      receipt,
    });
  }
  if (prior?.purchase_requested)
    return freeze({ disposition: "AMENDMENT_REQUIRED" as const, receipt });

  const purchase_intent: PurchaseOrderCreationIntent = {
    type: "CREATE_PURCHASE_ORDER",
    idempotency_key: `${source_key}:purchase`,
    buyer_company_id: connector.buyer_company_id,
    supplier_company_id: connector.supplier_company_id,
    source_order_reference: event.external_order_id,
    manual_buyer_approval_required: false,
    supplier_approval_required: true,
  };
  return freeze({
    disposition: "CREATE_EC_ORDER_AND_PURCHASE" as const,
    receipt,
    order: event,
    // Supplier purchase prices are resolved from the authorized supplier
    // catalogue; the consumer's retail price is not copied into this intent.
    purchase_intent,
  });
}
