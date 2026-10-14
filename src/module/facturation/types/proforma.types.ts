import type { ProformaOrderSource } from "../repository/proforma-source.repository";

export type ProformaPartySnapshot = { client_id: string; client_code: string | null; company_name: string;
  blocked: boolean; billing_address: Record<string, unknown> } & Record<string, unknown>;
export type ProformaPreviewPart = {
  billed_client_id: string; quantity: string; billed_client_snapshot: ProformaPartySnapshot;
  unit_price_ex_tax: string; discount_percent: string; global_discount_percent: string;
  tax_rate_percent: string; total_ex_tax: string; tax_amount: string; total_incl_tax: string;
};
export type ProformaPreviewAffair = {
  allocation_id: number; source_revision: string; source_snapshot: ProformaOrderSource;
  billing_parts: ProformaPreviewPart[];
};
export type ProformaCompanyTotal = { billed_client_id: string; company_name: string;
  total_ex_tax: string; tax_amount: string; total_incl_tax: string };
export type ProformaPreview = {
  version: 1; client_id: string; client_snapshot: ProformaPartySnapshot; currency: string;
  affairs: ProformaPreviewAffair[]; company_totals: ProformaCompanyTotal[];
  preview_hash: string;
};
export type ProformaCommandResult = { id: string; reference: string; status: "DRAFT" | "ISSUED" | "CANCELLED";
  row_version: number; correlation_id: string; idempotent_replay: boolean; document_archive_id?: string };
