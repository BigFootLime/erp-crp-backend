import type { PoolClient } from "pg";
import type { FinalInvoiceAffair, FinalInvoiceContribution } from "../domain/proforma-final-invoice";

type Queryer = Pick<PoolClient, "query">;
export type FinalInvoiceAffairRow = FinalInvoiceAffair & { source_line_id: string };

/** One grouped physical affair per BL line; stock-lot joins never multiply quotas. */
export async function readProformaFinalInvoiceAffairs(
  tx: Queryer, sourceLineIds: readonly string[], billedClientId: string, ownInvoiceId?: number,
): Promise<FinalInvoiceAffairRow[]> {
  if (!sourceLineIds.length) return [];
  const result = await tx.query<FinalInvoiceAffairRow>(`
    WITH physical AS (
      SELECT delivery_line.id AS source_line_id,
        COALESCE(delivered.commande_ligne_affaire_allocation_id,reservation.commande_ligne_affaire_allocation_id) AS allocation_id,
        sum(delivered.quantite)::numeric(18,3) AS delivered_quantity
      FROM public.bon_livraison_ligne delivery_line
      JOIN public.bon_livraison_ligne_allocations delivered ON delivered.bon_livraison_ligne_id=delivery_line.id
      LEFT JOIN public.stock_reservations reservation ON reservation.id=delivered.reservation_id
      WHERE delivery_line.id=ANY($1::uuid[])
      GROUP BY delivery_line.id,COALESCE(delivered.commande_ligne_affaire_allocation_id,reservation.commande_ligne_affaire_allocation_id)
    )
    SELECT physical.source_line_id::text,physical.allocation_id::text,
      physical.delivered_quantity::text,
      COALESCE(physical_used.quantity,0)::numeric(18,3)::text AS quantity_already_selected,
      COALESCE(terms.requirement,command.delivery_prepayment_requirement,'UNCONFIRMED') AS requirement,
      proforma.id::text AS proforma_id,proforma.reference AS proforma_reference,proforma.status AS proforma_status,proforma.currency,
      part.id::text AS billing_part_id,part.billed_client_id,billed.company_name AS billed_client_name,
      COALESCE(billed.blocked,false) AS billed_client_blocked,part.quantity::text AS part_quantity,
      COALESCE(part_used.quantity,0)::numeric(18,3)::text AS part_already_selected,
      part.unit_price_ex_tax::text,part.discount_percent::text,part.global_discount_percent::text,
      part.tax_rate_percent::text,proforma_line.source_revision
    FROM physical
    JOIN public.commande_ligne_affaire_allocation affair ON affair.id=physical.allocation_id
    JOIN public.commande_client command ON command.id=affair.commande_id
    LEFT JOIN public.delivery_affair_prepayment_terms terms ON terms.allocation_id=affair.id
    LEFT JOIN public.proforma_affair_lines proforma_line ON proforma_line.id=terms.proforma_line_id
    LEFT JOIN public.proforma_client proforma ON proforma.id=proforma_line.proforma_id
    LEFT JOIN public.proforma_billing_parts part ON part.proforma_line_id=proforma_line.id AND part.billed_client_id=$2
    LEFT JOIN public.clients billed ON billed.client_id=part.billed_client_id
    LEFT JOIN LATERAL (
      SELECT sum(binding.quantity) AS quantity
      FROM public.proforma_final_invoice_sources binding
      JOIN public.facture_source_allocations source ON source.id=binding.facture_source_allocation_id
      JOIN public.proforma_billing_parts used_part ON used_part.id=binding.proforma_billing_part_id
      JOIN public.proforma_affair_lines used_line ON used_line.id=used_part.proforma_line_id
      WHERE source.source_type='DELIVERY_LINE' AND source.source_line_id=physical.source_line_id::text
        AND used_line.allocation_id=physical.allocation_id AND source.allocation_status IN ('DRAFT','CONSUMED')
        AND ($3::bigint IS NULL OR source.facture_id<>$3)
    ) physical_used ON true
    LEFT JOIN LATERAL (
      SELECT sum(binding.quantity) AS quantity
      FROM public.proforma_final_invoice_sources binding
      JOIN public.facture_source_allocations source ON source.id=binding.facture_source_allocation_id
      WHERE binding.proforma_billing_part_id=part.id AND source.allocation_status IN ('DRAFT','CONSUMED')
        AND ($3::bigint IS NULL OR source.facture_id<>$3)
    ) part_used ON true
    ORDER BY physical.source_line_id,physical.allocation_id
  `, [[...new Set(sourceLineIds)].sort(), billedClientId, ownInvoiceId ?? null]);
  return result.rows;
}

/** Persist exact affair/company contributions with the draft source, never cash. */
export async function bindProformaFinalInvoiceSourceTx(tx: Queryer, args: {
  sourceAllocationId: string;
  contributions: readonly FinalInvoiceContribution[];
  actorId: number;
  correlationId: string;
}): Promise<void> {
  for (const contribution of args.contributions) {
    await tx.query(`
      INSERT INTO public.proforma_final_invoice_sources (
        facture_source_allocation_id,proforma_billing_part_id,quantity,created_by,correlation_id
      ) VALUES ($1::uuid,$2::uuid,$3::numeric,$4,$5::uuid)
    `, [args.sourceAllocationId, contribution.billing_part_id, contribution.quantity, args.actorId, args.correlationId]);
  }
}

/** Used identically by count and page: another billed party needs issued authority. */
export function proformaBilledPartySourceWhere(parameter: string): string {
  return `EXISTS (
    SELECT 1 FROM public.bon_livraison_ligne_allocations delivered
    LEFT JOIN public.stock_reservations reservation ON reservation.id=delivered.reservation_id
    JOIN public.delivery_affair_prepayment_terms terms ON terms.allocation_id=
      COALESCE(delivered.commande_ligne_affaire_allocation_id,reservation.commande_ligne_affaire_allocation_id)
    JOIN public.proforma_affair_lines proforma_line ON proforma_line.id=terms.proforma_line_id
    JOIN public.proforma_client proforma ON proforma.id=proforma_line.proforma_id
    JOIN public.proforma_billing_parts part ON part.proforma_line_id=proforma_line.id
    WHERE delivered.bon_livraison_ligne_id=bll.id AND terms.requirement='PROFORMA'
      AND proforma.status='ISSUED' AND part.billed_client_id=${parameter}
  )`;
}
