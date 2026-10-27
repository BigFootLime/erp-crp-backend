import { z } from "zod";

export const INTERCOMPANY_REQUEST_STATES = [
  "PENDING_SUPPLIER_APPROVAL", "ACCEPTED", "REJECTED", "CANCEL_REQUESTED",
  "CANCELLATION_REJECTED", "CANCELLED", "PARTIALLY_FULFILLED", "FULFILLED",
] as const;
export type IntercompanyRequestState = (typeof INTERCOMPANY_REQUEST_STATES)[number];
export type IntercompanyRequestSummary = {
  id: string;
  buyer_company_id: string;
  supplier_company_id: string;
  environment: "cerp_prod" | "cerp_test";
  buyer_name: string | null;
  buyer_purchase_order_id: string;
  buyer_sales_order_id: string;
  revision: number;
  version: number;
  state: IntercompanyRequestState;
  supplier_sales_order_id: number | null;
  line_count: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decision_reason: string | null;
};
export type IntercompanyRequestDetail = IntercompanyRequestSummary & {
  /** Purchase price only; the buyer's customer price is never transmitted. */
  payload: Record<string, unknown>;
  allowed_actions: IntercompanyRequestAction[];
};
export const INTERCOMPANY_REQUEST_ACTIONS = ["ACCEPT", "REJECT", "REQUEST_CANCEL", "CONFIRM_CANCEL", "REJECT_CANCEL"] as const;
export type IntercompanyRequestAction = (typeof INTERCOMPANY_REQUEST_ACTIONS)[number];
export const intercompanyRequestDecisionSchema = z.object({
  action: z.enum(INTERCOMPANY_REQUEST_ACTIONS),
  expected_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  idempotency_key: z.string().trim().min(16).max(200),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict().superRefine((input, context) => {
  if (["REJECT", "REJECT_CANCEL"].includes(input.action) && !input.reason)
    context.addIssue({ code: "custom", path: ["reason"], message: "Un motif est requis." });
});
export type IntercompanyRequestDecision = z.infer<typeof intercompanyRequestDecisionSchema>;
export const intercompanyRequestListSchema = z.object({
  state: z.enum(INTERCOMPANY_REQUEST_STATES).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export type IntercompanyRequestList = {
  items: IntercompanyRequestSummary[];
  total: number;
  page: number;
  limit: number;
};
