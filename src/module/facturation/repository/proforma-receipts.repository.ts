import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { assertProformaReceiptBudget } from "../domain/proforma-funding";
import { formatDecimal, moneyToCents } from "../domain/decimal-money";
import type { ProformaReceiptAssignmentBodyDTO, ProformaReceiptReleaseBodyDTO } from "../validators/proforma.validators";
import type { FinanceActorContext } from "./workflow.repository.shared";
import { runProformaCommand } from "./proforma-transaction.repository";

type Context = { id: string; actor: FinanceActorContext; idempotencyKey: string | undefined };
type ReceiptDocument = { id: string; reference: string; status: string; row_version: number; currency: string };
function allocationId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id<=0) throw new HttpError(409,"PROFORMA_SOURCE_ID_INVALID","L'identité de cette affaire doit être vérifiée.");
  return id;
}
async function lockDocument(tx: PoolClient, id: string): Promise<ReceiptDocument> {
  const document = (await tx.query<ReceiptDocument>("SELECT id::text,reference,status,row_version,currency FROM public.proforma_client WHERE id=$1::uuid FOR UPDATE", [id])).rows[0];
  if (!document) throw new HttpError(404, "PROFORMA_NOT_FOUND", "Proforma introuvable.");
  return document;
}

/** Ventilates existing allocated cash; never inserts another Finance payment. */
export async function repoAssignProformaReceipts(args: Context & { input: ProformaReceiptAssignmentBodyDTO }) {
  return runProformaCommand({ ...args, commandType: "PROFORMA_RECEIPTS_ASSIGNED", payload: { id: args.id, ...args.input }, work: async (tx, correlationId) => {
    const document = await lockDocument(tx, args.id);
    if (document.status !== "ISSUED") throw new HttpError(409, "PROFORMA_NOT_ISSUED", "Émettez la proforma avant d'y affecter un règlement.");
    // Payment writers lock the payment before invoices. Keep the same order.
    const payment = (await tx.query<{ facture_id: string; amount: string; client_id: string; currency: string; status: string; workflow_status: string; reversal_of_id: string | null }>(`
      SELECT allocation.facture_id::text,allocation.amount_ttc::numeric(18,2)::text AS amount,
        payment.client_id::text,payment.currency,payment.status,payment.workflow_status,payment.reversal_of_id::text
      FROM public.paiement_allocations allocation JOIN public.paiement payment ON payment.id=allocation.paiement_id
      WHERE allocation.id=$1::uuid FOR UPDATE OF payment,allocation`, [args.input.payment_allocation_id])).rows[0];
    if (!payment) throw new HttpError(404, "PROFORMA_PAYMENT_ALLOCATION_NOT_FOUND", "Sélectionnez un règlement déjà affecté à sa facture d'acompte.");
    if (payment.currency !== document.currency || payment.reversal_of_id !== null
      || !["UNALLOCATED","PARTIALLY_ALLOCATED","ALLOCATED"].includes(payment.status)
      || !["RECORDED","ALLOCATED"].includes(payment.workflow_status)) {
      throw new HttpError(409, "PROFORMA_PAYMENT_NOT_AVAILABLE", "Ce règlement n'est plus disponible dans la devise de la proforma.");
    }
    const invoice = (await tx.query<{ document_status: string; client_id: string; currency: string }>(
      "SELECT document_status,client_id::text,currency FROM public.facture WHERE id=$1::bigint FOR UPDATE", [payment.facture_id])).rows[0];
    if (!invoice || invoice.document_status !== "ISSUED" || invoice.client_id !== payment.client_id || invoice.currency !== document.currency) {
      throw new HttpError(409, "PROFORMA_DEPOSIT_NOT_ISSUED", "Le règlement doit porter sur une facture d'acompte émise pour cette société.");
    }
    const targets = (await tx.query<{ id: string; source_id: string; allocation_id: string; billed_client_id: string; amount: string; allocation_status: string; source_type: string }>(`
      SELECT part.id::text,source.id::text AS source_id,line.allocation_id::text,part.billed_client_id,
        source.amount_incl_tax::numeric(18,2)::text AS amount,source.allocation_status,source.source_type
      FROM public.proforma_billing_parts part JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
      JOIN public.proforma_deposit_sources binding ON binding.proforma_billing_part_id=part.id
      JOIN public.facture_source_allocations source ON source.id=binding.facture_source_allocation_id
      WHERE line.proforma_id=$1::uuid AND source.facture_id=$2::bigint AND source.id=ANY($3::uuid[])
      ORDER BY part.id,source.id FOR UPDATE OF part,source`, [args.id,payment.facture_id,args.input.assignments.map(target=>target.deposit_source_id)])).rows;
    for (const selection of args.input.assignments) {
      const target = targets.find(target=>target.source_id===selection.deposit_source_id && target.id===selection.proforma_billing_part_id);
      if (!target || target.billed_client_id !== payment.client_id || target.source_type !== "DEPOSIT" || target.allocation_status !== "CONSUMED") {
        throw new HttpError(409, "PROFORMA_RECEIPT_TARGET_MISMATCH", "Choisissez une ligne d'acompte de cette proforma et de la société qui a réglé.");
      }
    }
    const used = (await tx.query<{ amount: string }>(`SELECT COALESCE(sum(receipt.amount_ttc-COALESCE(released.amount,0)),0)::numeric(18,2)::text AS amount
      FROM public.proforma_receipt_assignments receipt LEFT JOIN LATERAL (SELECT sum(amount_ttc) AS amount FROM public.proforma_receipt_releases WHERE assignment_id=receipt.id) released ON true
      WHERE receipt.payment_allocation_id=$1::uuid`, [args.input.payment_allocation_id])).rows[0]?.amount ?? "0.00";
    const requested = args.input.assignments.reduce((sum,target)=>sum+moneyToCents(target.amount),0n);
    assertProformaReceiptBudget({ allocatedAmount: payment.amount, usedAmount: used, requestedAmount: formatDecimal(requested,2) });
    const sourceUsage = (await tx.query<{ source_id: string; amount: string }>(`SELECT receipt.deposit_source_id::text AS source_id,
      COALESCE(sum(receipt.amount_ttc-COALESCE(released.amount,0)),0)::numeric(18,2)::text AS amount
      FROM public.proforma_receipt_assignments receipt LEFT JOIN LATERAL (SELECT sum(amount_ttc) AS amount FROM public.proforma_receipt_releases WHERE assignment_id=receipt.id) released ON true
      WHERE receipt.deposit_source_id=ANY($1::uuid[]) GROUP BY receipt.deposit_source_id`, [args.input.assignments.map(target=>target.deposit_source_id)])).rows;
    for (const target of targets) {
      const requested = args.input.assignments.filter(selection=>selection.deposit_source_id===target.source_id).reduce((sum,selection)=>sum+moneyToCents(selection.amount),0n);
      const used = moneyToCents(sourceUsage.find(source=>source.source_id===target.source_id)?.amount ?? "0.00");
      if (used<0n || used+requested>moneyToCents(target.amount)) throw new HttpError(409,"PROFORMA_DEPOSIT_RECEIPT_EXCEEDED","Le montant dépasse l'acompte encore disponible pour cette affaire.");
    }
    const assignments: Array<{ id: string; deposit_source_id: string; amount: string }> = [];
    for (const selection of [...args.input.assignments].sort((a,b)=>a.deposit_source_id.localeCompare(b.deposit_source_id))) {
      const id = crypto.randomUUID(),amount = formatDecimal(moneyToCents(selection.amount),2);
      await tx.query(`INSERT INTO public.proforma_receipt_assignments(id,payment_allocation_id,deposit_source_id,amount_ttc,created_by,correlation_id)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::numeric,$5,$6::uuid)`, [id,args.input.payment_allocation_id,selection.deposit_source_id,amount,args.actor.userId,correlationId]);
      assignments.push({ id,deposit_source_id: selection.deposit_source_id,amount });
    }
    return { aggregateId: args.id, deliveryAllocationIds: [...new Set(targets.map(target=>allocationId(target.allocation_id)))],
      result: { id: args.id, reference: document.reference, status: "ISSUED" as const, row_version: document.row_version, assignments,
        payment_allocation_id: args.input.payment_allocation_id },
      newValues: { payment_allocation_id: args.input.payment_allocation_id, assignments, second_cash_entry_created: false } };
  } });
}

/** Releases a linkage, with retained proof. This does not refund or reverse cash. */
export async function repoReleaseProformaReceipt(args: Context & { assignmentId: string; input: ProformaReceiptReleaseBodyDTO }) {
  return runProformaCommand({ ...args, commandType: "PROFORMA_RECEIPT_RELEASED", payload: { id: args.id, assignment_id: args.assignmentId, ...args.input }, work: async (tx, correlationId) => {
    const document = await lockDocument(tx, args.id);
    const assignment = (await tx.query<{ id: string; allocation_id: string; amount: string; released: string }>(`
      SELECT receipt.id::text,line.allocation_id::text,receipt.amount_ttc::numeric(18,2)::text AS amount,
        COALESCE((SELECT sum(amount_ttc) FROM public.proforma_receipt_releases WHERE assignment_id=receipt.id),0)::numeric(18,2)::text AS released
      FROM public.proforma_receipt_assignments receipt JOIN public.proforma_deposit_sources binding ON binding.facture_source_allocation_id=receipt.deposit_source_id
      JOIN public.proforma_billing_parts part ON part.id=binding.proforma_billing_part_id
      JOIN public.proforma_affair_lines line ON line.id=part.proforma_line_id
      WHERE receipt.id=$1::uuid AND line.proforma_id=$2::uuid`, [args.assignmentId,args.id])).rows[0];
    if (!assignment) throw new HttpError(404, "PROFORMA_RECEIPT_NOT_FOUND", "Cette ventilation ne correspond pas à la proforma.");
    const amount = moneyToCents(args.input.amount),available=moneyToCents(assignment.amount)-moneyToCents(assignment.released);
    if (amount<=0n || amount>available) throw new HttpError(409, "PROFORMA_RECEIPT_RELEASE_EXCEEDED", "Le montant dépasse la ventilation encore liée à cette affaire.");
    const id = crypto.randomUUID();
    await tx.query(`INSERT INTO public.proforma_receipt_releases(id,assignment_id,amount_ttc,reason,created_by,correlation_id)
      VALUES($1::uuid,$2::uuid,$3::numeric,$4,$5,$6::uuid)`, [id,args.assignmentId,formatDecimal(amount,2),args.input.reason,args.actor.userId,correlationId]);
    return { aggregateId: args.id, deliveryAllocationIds: [allocationId(assignment.allocation_id)],
      result: { id: args.id, reference: document.reference, status: document.status, row_version: document.row_version,
        release_id: id, assignment_id: args.assignmentId, released_amount: formatDecimal(amount,2) },
      newValues: { assignment_id: args.assignmentId, released_amount: formatDecimal(amount,2),reason: args.input.reason, cash_reversed: false } };
  } });
}
