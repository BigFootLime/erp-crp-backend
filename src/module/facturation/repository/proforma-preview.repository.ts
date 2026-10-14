import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { formatDecimal, moneyToCents } from "../domain/decimal-money";
import { proformaBillingDistribution } from "../domain/proforma-billing-distribution";
import { financePreviewHash } from "../domain/finance-policy";
import type { ProformaPartySnapshot, ProformaPreview, ProformaPreviewAffair, ProformaCompanyTotal } from "../types/proforma.types";
import type { ProformaDraftBodyDTO } from "../validators/proforma.validators";
import { assertProformaOrderSource, proformaOrderSourceRevision, readProformaOrderSources } from "./proforma-source.repository";

type Queryer = Pick<PoolClient, "query">;
export async function readProformaParties(tx: Queryer, clientIds: readonly string[]): Promise<Map<string, ProformaPartySnapshot>> {
  const ids = [...new Set(clientIds)].sort();
  const result = await tx.query<{ snapshot: ProformaPartySnapshot }>(`
    SELECT jsonb_build_object('client_id',c.client_id,'client_code',c.client_code,
      'company_name',c.company_name,'siret',c.siret,'vat_number',c.vat_number,'blocked',COALESCE(c.blocked,false),
      'billing_address',jsonb_build_object('name',address.name,'street',address.street,'house_number',address.house_number,
        'address_complement',address.address_complement,'postal_code',address.postal_code,'city',address.city,'country',address.country)) AS snapshot
    FROM public.clients c LEFT JOIN public.adresse_facturation address ON address.bill_address_id=c.bill_address_id
    WHERE c.client_id=ANY($1::text[]) ORDER BY c.client_id
  `, [ids]);
  const parties = new Map(result.rows.map(row => [row.snapshot.client_id, row.snapshot]));
  if (parties.size !== ids.length) throw new HttpError(404, "PROFORMA_BILLED_COMPANY_NOT_FOUND", "Une société sélectionnée n'existe plus.");
  if ([...parties.values()].some(party => party.blocked)) throw new HttpError(409, "PROFORMA_BILLED_COMPANY_BLOCKED", "Une société sélectionnée est bloquée.");
  return parties;
}

export async function buildProformaPreview(tx: Queryer, input: ProformaDraftBodyDTO, lock: boolean, ownProformaId?: string): Promise<ProformaPreview> {
  const sources = await readProformaOrderSources(tx, input.affairs.map(affair => affair.allocation_id), lock);
  const parties = await readProformaParties(tx, [input.client_id, ...input.affairs.flatMap(affair => affair.billing_parts.map(part => part.billed_client_id))]);
  const selections = new Map(input.affairs.map(affair => [affair.allocation_id, affair]));
  const affairs: ProformaPreviewAffair[] = sources.map(source => {
    assertProformaOrderSource(source, input.client_id, input.currency);
    if (source.has_active_delivery) throw new HttpError(409, "PROFORMA_AFFAIR_DELIVERY_EXISTS", "Cette affaire possède déjà un BL : régularisez sa préparation avant de changer son paiement.", { allocation_id: source.allocation_id });
    if (source.bound_proforma_id && source.bound_proforma_id !== ownProformaId && source.bound_proforma_status !== "CANCELLED") {
      throw new HttpError(409, "PROFORMA_AFFAIR_ALREADY_BOUND", "Cette affaire dispose déjà d'une proforma : ouvrez-la pour continuer.", { proforma_id: source.bound_proforma_id, allocation_id: source.allocation_id });
    }
    const selection = selections.get(source.allocation_id)!;
    const distribution = proformaBillingDistribution({ sourceQuantity: source.quantity,
      unitPriceExTax: source.unit_price_ex_tax!, discountPercent: source.discount_percent ?? "0",
      globalDiscountPercent: source.global_discount_percent ?? "0", taxRatePercent: source.tax_rate_percent!,
      parts: selection.billing_parts.map(part => ({ billedClientId: part.billed_client_id, quantity: part.quantity })) })
      .sort((a,b) => a.billedClientId.localeCompare(b.billedClientId));
    // Internal share IDs are excluded from the commercial revision. Persisted
    // shares are allocated during creation, with these exact quantities.
    const proposedSource = { ...source, billing_shares: distribution.map(part => ({ id: "", billed_client_id: part.billedClientId, quantity: part.quantity })) };
    const { prepayment_requirement: _requirement, terms_version: _version,
      bound_proforma_id: _boundId, bound_proforma_status: _boundStatus,
      bound_proforma_reference: _boundReference, bound_proforma_source_revision: _boundRevision,
      has_active_delivery: _hasDelivery, ...snapshot } = proposedSource;
    return { allocation_id: source.allocation_id, source_revision: proformaOrderSourceRevision(proposedSource, input.currency),
      source_snapshot: snapshot, billing_parts: distribution.map(part => ({ billed_client_id: part.billedClientId,
        quantity: part.quantity, billed_client_snapshot: parties.get(part.billedClientId)!,
        unit_price_ex_tax: source.unit_price_ex_tax!, discount_percent: source.discount_percent ?? "0.0000",
        global_discount_percent: part.globalDiscountPercent, tax_rate_percent: source.tax_rate_percent!,
        total_ex_tax: part.totalExTax, tax_amount: part.taxAmount, total_incl_tax: part.totalInclTax })) };
  });
  const totals = new Map<string, { company_name: string; exTax: bigint; tax: bigint; inclTax: bigint }>();
  for (const affair of affairs) for (const part of affair.billing_parts) {
    const value = totals.get(part.billed_client_id) ?? { company_name: part.billed_client_snapshot.company_name, exTax: 0n, tax: 0n, inclTax: 0n };
    value.exTax += moneyToCents(part.total_ex_tax); value.tax += moneyToCents(part.tax_amount); value.inclTax += moneyToCents(part.total_incl_tax);
    totals.set(part.billed_client_id, value);
  }
  const companyTotals: ProformaCompanyTotal[] = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => ({
    billed_client_id: id, company_name: value.company_name, total_ex_tax: formatDecimal(value.exTax, 2),
    tax_amount: formatDecimal(value.tax, 2), total_incl_tax: formatDecimal(value.inclTax, 2),
  }));
  const preview = { version: 1 as const, client_id: input.client_id, client_snapshot: parties.get(input.client_id)!,
    currency: input.currency, affairs, company_totals: companyTotals };
  return { ...preview, preview_hash: financePreviewHash(preview) };
}
