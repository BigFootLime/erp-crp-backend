import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { ProformaCommandResult } from "../types/proforma.types";
import type { ProformaCancelBodyDTO, ProformaDraftBodyDTO, ProformaRefreshBodyDTO } from "../validators/proforma.validators";
import type { FinanceActorContext } from "./workflow.repository.shared";
import { lockProforma } from "./proforma-command.repository";
import { persistProformaDraftContentTx } from "./proforma-draft-content.repository";
import { buildProformaPreview } from "./proforma-preview.repository";
import { readProformaOrderSources } from "./proforma-source.repository";
import { runProformaCommand } from "./proforma-transaction.repository";

type Context = { actor: FinanceActorContext; idempotencyKey: string | undefined; id: string };
function requireSameIdentity(document: { client_id: string; currency: string }, input: ProformaDraftBodyDTO): void {
  if (document.client_id !== input.client_id || document.currency !== input.currency) {
    throw new HttpError(409, "PROFORMA_IDENTITY_CHANGED", "Le client et la devise sont conservés. Préparez une autre proforma pour les changer.");
  }
}

export async function repoPreviewProformaChanges(id: string, input: ProformaDraftBodyDTO) {
  const document = (await pool.query<{ status: string; client_id: string; currency: string }>(
    "SELECT status,client_id,currency FROM public.proforma_client WHERE id=$1::uuid", [id])).rows[0];
  if (!document) throw new HttpError(404, "PROFORMA_NOT_FOUND", "Proforma introuvable.");
  if (document.status !== "DRAFT") throw new HttpError(409, "PROFORMA_NOT_DRAFT", "La proforma émise est figée.");
  requireSameIdentity(document, input);
  return buildProformaPreview(pool, input, false, id);
}

export async function repoRefreshProforma(args: Context & { input: ProformaRefreshBodyDTO }): Promise<ProformaCommandResult> {
  return runProformaCommand({ ...args, commandType: "PROFORMA_DRAFT_REFRESHED", payload: { id: args.id, ...args.input }, work: async (tx, correlationId) => {
    const document = await lockProforma(tx, args.id, args.input.expected_version);
    if (document.status !== "DRAFT") throw new HttpError(409, "PROFORMA_NOT_DRAFT", "La proforma émise est figée.");
    requireSameIdentity(document, args.input);
    const oldIds = document.preview_payload.affairs.map(affair => affair.allocation_id);
    const newIds = args.input.affairs.map(affair => affair.allocation_id);
    const sources = await readProformaOrderSources(tx, [...new Set([...oldIds, ...newIds])].sort((a,b) => a-b), true);
    if (sources.some(source => source.has_active_delivery)) throw new HttpError(409, "PROFORMA_AFFAIR_DELIVERY_EXISTS", "Régularisez le BL lié avant de modifier la proforma.");
    const preview = await buildProformaPreview(tx, args.input, true, args.id);
    if (preview.preview_hash !== args.input.preview_hash) throw new HttpError(409, "PROFORMA_PREVIEW_CHANGED", "Les données commerciales ont changé : actualisez l'aperçu.", { preview });
    const removed = oldIds.filter(id => !newIds.includes(id));
    // Removing an affair does not silently grant permission to ship it unpaid.
    // An explicit terms decision remains necessary before its next delivery.
    if (removed.length) {
      await tx.query(`UPDATE public.delivery_affair_prepayment_terms terms SET requirement='UNCONFIRMED',proforma_line_id=NULL,
        row_version=terms.row_version+1,decision_reason=$3,updated_at=now(),updated_by=$4,correlation_id=$5::uuid
        FROM public.proforma_affair_lines line WHERE line.id=terms.proforma_line_id AND line.proforma_id=$1::uuid AND line.allocation_id=ANY($2::bigint[])`,
        [args.id, removed, `Affaire retirée du brouillon ${document.reference}`, args.actor.userId, correlationId]);
    }
    await tx.query(`DELETE FROM public.proforma_billing_parts part USING public.proforma_affair_lines line
      WHERE part.proforma_line_id=line.id AND line.proforma_id=$1::uuid`, [args.id]);
    if (removed.length) await tx.query("DELETE FROM public.proforma_affair_lines WHERE proforma_id=$1::uuid AND allocation_id=ANY($2::bigint[])", [args.id, removed]);
    await persistProformaDraftContentTx(tx, { id: args.id, reference: document.reference, preview, actorId: args.actor.userId, correlationId });
    await tx.query("UPDATE public.proforma_client SET preview_payload=$2::jsonb,preview_hash=$3,row_version=row_version+1 WHERE id=$1::uuid", [args.id, JSON.stringify(preview), preview.preview_hash]);
    return { aggregateId: args.id, deliveryAllocationIds: [...new Set([...oldIds, ...newIds])],
      oldValues: { status: document.status, row_version: document.row_version, preview_hash: document.preview_hash },
      newValues: { row_version: document.row_version+1, preview_hash: preview.preview_hash, removed_affairs: removed },
      result: { id: args.id, reference: document.reference, status: "DRAFT" as const, row_version: document.row_version+1 } };
  } });
}

export async function repoCancelProforma(args: Context & { input: ProformaCancelBodyDTO }): Promise<ProformaCommandResult> {
  return runProformaCommand({ ...args, commandType: "PROFORMA_CANCELLED", payload: { id: args.id, ...args.input }, work: async tx => {
    const document = await lockProforma(tx, args.id, args.input.expected_version);
    if (document.status === "CANCELLED") throw new HttpError(409, "PROFORMA_ALREADY_CANCELLED", "Cette proforma est déjà annulée.");
    const ids = document.preview_payload.affairs.map(affair => affair.allocation_id);
    const sources = await readProformaOrderSources(tx, ids, true);
    if (sources.some(source => source.has_active_delivery)) throw new HttpError(409, "PROFORMA_AFFAIR_DELIVERY_EXISTS", "Le BL lié doit être régularisé avant l'annulation de la proforma.");
    const deposits = (await tx.query<{ facture_id: string; reference: string }>(`SELECT DISTINCT invoice.id::text AS facture_id,invoice.numero AS reference
      FROM public.proforma_affair_lines line JOIN public.proforma_billing_parts part ON part.proforma_line_id=line.id
      JOIN public.proforma_deposit_sources binding ON binding.proforma_billing_part_id=part.id
      JOIN public.facture_source_allocations source ON source.id=binding.facture_source_allocation_id
      JOIN public.facture invoice ON invoice.id=source.facture_id
      WHERE line.proforma_id=$1::uuid AND source.allocation_status IN ('DRAFT','CONSUMED') ORDER BY invoice.id::text`, [args.id])).rows;
    if (deposits.length) throw new HttpError(409, "PROFORMA_DEPOSIT_RECONCILIATION_REQUIRED", "Régularisez les factures d'acompte liées dans Finance avant d'annuler la proforma.", { invoices: deposits });
    const pending = (await tx.query<{ id: string }>(`SELECT receipt.id::text FROM public.proforma_receipt_assignments receipt
      JOIN public.proforma_deposit_sources binding ON binding.facture_source_allocation_id=receipt.deposit_source_id
      JOIN public.proforma_billing_parts part ON part.id=binding.proforma_billing_part_id
      JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
      WHERE line.proforma_id=$1::uuid AND receipt.amount_ttc>COALESCE((SELECT sum(amount_ttc) FROM public.proforma_receipt_releases WHERE assignment_id=receipt.id),0)`, [args.id])).rows;
    if (pending.length) throw new HttpError(409, "PROFORMA_RECEIPT_RECONCILIATION_REQUIRED", "Libérez les ventilations d'encaissement liées avant d'annuler cette proforma.");
    await tx.query(`UPDATE public.proforma_client SET status='CANCELLED',row_version=row_version+1,
      cancelled_at=now(),cancelled_by=$2,cancellation_reason=$3 WHERE id=$1::uuid`, [args.id, args.actor.userId, args.input.reason]);
    // Keep the original terms and issued snapshot. Cancellation is not a waiver.
    return { aggregateId: args.id, deliveryAllocationIds: ids, oldValues: { status: document.status, row_version: document.row_version },
      newValues: { status: "CANCELLED", reason: args.input.reason },
      result: { id: args.id, reference: document.reference, status: "CANCELLED" as const, row_version: document.row_version+1 } };
  } });
}
