import type {
  AvoirWorkflowStatus,
  FactureWorkflowStatus,
  PaymentStatus,
} from "../domain/finance-policy";
import type { InvoiceRegulatorySnapshot } from "../electronic-invoicing/electronic-invoice-regulatory.domain";

export type FinanceBlocker = {
  code: string;
  message: string;
  source_line_id?: string;
};

export type EligibleDeliverySource = {
  source_type: "DELIVERY_LINE";
  source_id: string;
  source_line_id: string;
  delivery_number: string;
  delivery_status: "SHIPPED" | "DELIVERED";
  client_id: string;
  client_name: string;
  commande_id: number | null;
  affaire_id: number | null;
  commande_line_id: number | null;
  designation: string;
  code_piece: string | null;
  unit: string | null;
  quantity_source: string;
  quantity_already_invoiced: string;
  quantity_already_credited: string;
  quantity_remaining: string;
  unit_price_ex_tax: string | null;
  discount_percent: string | null;
  tax_rate_percent: string | null;
  pricing_version: string | null;
  rule_code: string;
  blockers: FinanceBlocker[];
};

export type FacturePreviewLine = {
  source_type: "DELIVERY_LINE" | "MILESTONE" | "DEPOSIT";
  source_id: string;
  source_line_id: string;
  designation: string;
  code_piece: string | null;
  quantity: string;
  unit: string | null;
  unit_price_ex_tax: string;
  discount_percent: string;
  tax_rate_percent: string;
  total_ex_tax: string;
  tax_amount: string;
  total_incl_tax: string;
  pricing_version: string | null;
  rule_code: string;
};

export type FinanceDueDate = {
  id?: string;
  due_date: string;
  label: string;
  amount: string;
  allocated_amount?: string;
  balance?: string;
  status?: "OPEN" | "PARTIALLY_PAID" | "PAID" | "OVERDUE";
};

export type FacturePreview = {
  preview_version: 1;
  client_id: string;
  currency: string;
  lines: FacturePreviewLine[];
  totals: {
    subtotal_ex_tax: string;
    global_discount_percent: string;
    global_discount_amount: string;
    total_ex_tax: string;
    total_tax: string;
    total_incl_tax: string;
  };
  due_dates: FinanceDueDate[];
  regulatory_snapshot: InvoiceRegulatorySnapshot | null;
  blockers: FinanceBlocker[];
  warnings: FinanceBlocker[];
  preview_hash: string;
};

export type FinanceCommandResult = {
  id: number;
  uuid: string;
  draft_reference: string;
  legal_number: string | null;
  status: FactureWorkflowStatus | AvoirWorkflowStatus;
  row_version: number;
  correlation_id: string;
  idempotent_replay: boolean;
};

export type AvoirPreviewLine = {
  facture_line_id: number;
  designation: string;
  code_piece: string | null;
  quantity_invoiced: string;
  quantity_already_credited: string;
  quantity_remaining: string;
  quantity_selected: string;
  unit: string | null;
  unit_price_ex_tax: string;
  discount_percent: string;
  tax_rate_percent: string;
  total_ex_tax: string;
  tax_amount: string;
  total_incl_tax: string;
};

export type AvoirPreview = {
  preview_version: 1;
  facture_id: number;
  facture_number: string;
  client_id: string;
  currency: string;
  reason_code: string;
  reason: string;
  lines: AvoirPreviewLine[];
  totals: {
    subtotal_ex_tax: string;
    global_discount_percent: string;
    global_discount_amount: string;
    total_ex_tax: string;
    total_tax: string;
    total_incl_tax: string;
  };
  blockers: FinanceBlocker[];
  warnings: FinanceBlocker[];
  preview_hash: string;
};

export type PaymentCommandResult = {
  id: number;
  uuid: string;
  code: string;
  status: PaymentStatus;
  row_version: number;
  amount: string;
  allocated_amount: string;
  available_amount: string;
  correlation_id: string;
  idempotent_replay: boolean;
};
