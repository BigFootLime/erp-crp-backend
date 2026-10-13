import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { financeRequestHash } from "../domain/finance-policy";
import { parseDecimal } from "../domain/decimal-money";

export type ProformaOrderSource = {
  allocation_id: number;
  commande_id: string;
  commande_ligne_id: string;
  livraison_affaire_id: string;
  client_id: string | null;
  currency: string;
  client_blocked: boolean;
  order_type: string;
  affaire_status: string;
  delivery_address_id: string | null;
  contract_id: string | null;
  article_id: string | null;
  piece_technique_version_id: string | null;
  code_piece: string | null;
  designation: string | null;
  quantity: string;
  unit: string | null;
  unit_price_ex_tax: string | null;
  discount_percent: string | null;
  global_discount_percent: string | null;
  tax_rate_percent: string | null;
  billing_shares: Array<{ id: string; billed_client_id: string; quantity: string }>;
  order_reference?: string;
  customer_order_reference?: string | null;
  affaire_reference?: string;
  prepayment_requirement?: "NOT_REQUIRED" | "PROFORMA" | "UNCONFIRMED";
  terms_version?: number;
  bound_proforma_id?: string | null;
  bound_proforma_status?: string | null;
  bound_proforma_reference?: string | null;
  bound_proforma_source_revision?: string | null;
  has_active_delivery?: boolean;
};

/** Server-selected order evidence, read in one snapshot; no UI price/paid field. */
export async function readProformaOrderSources(tx: Pick<PoolClient, "query">, allocationIds: readonly number[], lock: boolean): Promise<ProformaOrderSource[]> {
  if (!allocationIds.length || allocationIds.some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(allocationIds).size !== allocationIds.length) {
    throw new HttpError(422, "PROFORMA_AFFAIRS_INVALID", "Sélectionnez des affaires distinctes.");
  }
  if (lock) {
    await tx.query(`SELECT command.id FROM public.commande_client command
      WHERE command.id IN (SELECT commande_id FROM public.commande_ligne_affaire_allocation WHERE id=ANY($1::bigint[]))
      ORDER BY command.id FOR UPDATE`, [[...allocationIds].sort((a,b)=>a-b)]);
    await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('delivery-contract-binding',0))");
  }
  const result = await tx.query<Omit<ProformaOrderSource, "allocation_id"> & { allocation_id: string }>(`
    SELECT allocation.id::text AS allocation_id, allocation.commande_id::text,
      allocation.commande_ligne_id::text, allocation.livraison_affaire_id::text,
      command.client_id::text,command.currency, COALESCE(customer.blocked,false) AS client_blocked,
      command.order_type, affaire.statut::text AS affaire_status,
      COALESCE(command.destinataire_id,customer.delivery_address_id)::text AS delivery_address_id,
      COALESCE(call.contract_id,legacy.contract_id)::text AS contract_id,
      COALESCE(allocation.article_ref_id,line.article_id)::text AS article_id,
      line.piece_technique_version_id::text, line.code_piece, line.designation,
      allocation.qty_ordered::numeric(18,3)::text AS quantity, line.unite AS unit,
      line.prix_unitaire_ht::numeric(18,4)::text AS unit_price_ex_tax,
      line.remise_ligne::numeric(8,4)::text AS discount_percent,
      command.remise_globale::numeric(8,4)::text AS global_discount_percent,
      line.taux_tva::numeric(8,4)::text AS tax_rate_percent,
      command.numero AS order_reference,command.code_client AS customer_order_reference,
      affaire.reference AS affaire_reference,
      COALESCE(terms.requirement,command.delivery_prepayment_requirement,'UNCONFIRMED') AS prepayment_requirement,
      COALESCE(terms.row_version,0) AS terms_version,
      bound.id::text AS bound_proforma_id,bound.status AS bound_proforma_status,
      bound.reference AS bound_proforma_reference,bound_line.source_revision AS bound_proforma_source_revision,
      EXISTS(SELECT 1 FROM public.bon_livraison_ligne_allocations delivery_allocation
        JOIN public.bon_livraison_ligne delivery_line ON delivery_line.id=delivery_allocation.bon_livraison_ligne_id
        JOIN public.bon_livraison delivery ON delivery.id=delivery_line.bon_livraison_id
        WHERE delivery_allocation.commande_ligne_affaire_allocation_id=allocation.id
          AND delivery.statut IN ('READY','SHIPPED','DELIVERED')) AS has_active_delivery,
      COALESCE(shares.items,'[]'::jsonb) AS billing_shares
    FROM public.commande_ligne_affaire_allocation allocation
    JOIN public.commande_client command ON command.id=allocation.commande_id
    JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id AND line.commande_id=command.id
    JOIN public.affaire affaire ON affaire.id=allocation.livraison_affaire_id
    LEFT JOIN public.clients customer ON customer.client_id=command.client_id
    LEFT JOIN public.client_contract_calls call ON call.commande_id=command.id
    LEFT JOIN public.client_contract_legacy_orders legacy ON legacy.commande_id=command.id
    LEFT JOIN public.delivery_affair_prepayment_terms terms ON terms.allocation_id=allocation.id
    LEFT JOIN public.proforma_affair_lines bound_line ON bound_line.id=terms.proforma_line_id
    LEFT JOIN public.proforma_client bound ON bound.id=bound_line.proforma_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',share.id::text,'billed_client_id',share.billed_client_id,
        'quantity',share.quantity::numeric(18,3)::text) ORDER BY share.billed_client_id,share.id) AS items
      FROM public.delivery_affair_billing_shares share WHERE share.allocation_id=allocation.id AND share.active
    ) shares ON true
    WHERE allocation.id=ANY($1::bigint[]) ORDER BY allocation.id
    ${lock ? "FOR UPDATE OF allocation,command,line,affaire" : ""}
  `, [[...allocationIds].sort((a, b) => a - b)]);
  if (result.rows.length !== allocationIds.length) throw new HttpError(404, "PROFORMA_AFFAIR_NOT_FOUND", "Une affaire sélectionnée n'existe plus.");
  return result.rows.map(row => {
    const id = Number(row.allocation_id);
    if (!Number.isSafeInteger(id) || !allocationIds.includes(id)) throw new HttpError(409, "PROFORMA_SOURCE_ID_INVALID", "L'identité d'une affaire doit être vérifiée.");
    return { ...row, allocation_id: id };
  });
}

export function assertProformaOrderSource(source: ProformaOrderSource, clientId: string, currency = source.currency): void {
  if (source.client_id !== clientId) throw new HttpError(422, "PROFORMA_CUSTOMER_MISMATCH", "Toutes les affaires doivent appartenir au client sélectionné.");
  if (source.client_blocked) throw new HttpError(409, "PROFORMA_CUSTOMER_BLOCKED", "Le client sélectionné est bloqué.");
  if (source.currency !== currency) throw new HttpError(422, "PROFORMA_ORDER_CURRENCY_MISMATCH", "La proforma doit utiliser la devise de la commande source.");
  if (source.order_type === "INTERNE" || ["ANNULE", "ANNULEE", "CANCELLED"].includes(source.affaire_status)) {
    throw new HttpError(409, "PROFORMA_AFFAIR_NOT_ELIGIBLE", "Cette affaire ne peut pas recevoir une proforma client.");
  }
  if (parseDecimal(source.quantity, 3, "Quantité de l'affaire") <= 0n) throw new HttpError(422, "PROFORMA_QUANTITY_INVALID", "La quantité de l'affaire doit être positive.");
  if (source.unit_price_ex_tax === null || source.tax_rate_percent === null) {
    throw new HttpError(409, "PROFORMA_ORDER_PRICING_REQUIRED", "Complétez le prix et la TVA dans la commande source.");
  }
}

/** Due-date/stock/planning changes do not rewrite the commercial payment terms. */
export function proformaOrderSourceRevision(source: ProformaOrderSource, currency: string): string {
  return financeRequestHash("PROFORMA_ORDER_SOURCE_V1", {
    allocationId: source.allocation_id, orderId: source.commande_id, orderLineId: source.commande_ligne_id,
    affairId: source.livraison_affaire_id, clientId: source.client_id, currency,
    articleId: source.article_id, technicalVersionId: source.piece_technique_version_id,
    reference: source.code_piece, designation: source.designation, quantity: source.quantity, unit: source.unit,
    unitPrice: source.unit_price_ex_tax, discount: source.discount_percent ?? "0.0000",
    globalDiscount: source.global_discount_percent ?? "0.0000", taxRate: source.tax_rate_percent,
    addressId: source.delivery_address_id, contractId: source.contract_id,
    billingShares: (source.billing_shares.length ? source.billing_shares
      : source.client_id ? [{ billed_client_id: source.client_id, quantity: source.quantity }] : [])
      .map(share => ({ billedClientId: share.billed_client_id, quantity: share.quantity }))
      .sort((a, b) => a.billedClientId.localeCompare(b.billedClientId)),
  });
}
