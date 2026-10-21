import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { financePreviewHash } from "../domain/finance-policy";
import type { ProformaCommandResult, ProformaPreview } from "../types/proforma.types";
import type { ProformaCreateBodyDTO, ProformaIssueBodyDTO, DeliveryPrepaymentTermsBodyDTO } from "../validators/proforma.validators";
import type { FinanceActorContext } from "./workflow.repository.shared";
import { issuerSnapshotAt } from "./workflow.repository.shared";
import { buildProformaPreview } from "./proforma-preview.repository";
import { readProformaOrderSources } from "./proforma-source.repository";
import { persistProformaDraftContentTx } from "./proforma-draft-content.repository";
import { runProformaCommand } from "./proforma-transaction.repository";
import { assertFinancialCutoverEmissionAllowedTx } from "./financial-cutover-guard";
import { todayInParis } from "../domain/reporting-policy";
import { queueCreationPdfArchive } from "../../../shared/authoritative-documents/authoritative-document.service";
import { renderProformaDocument, type ProformaDocumentSnapshot } from "../services/proforma-document";

type CommandContext = { actor: FinanceActorContext; idempotencyKey: string | undefined };
type LockedProforma = { id: string; reference: string; status: "DRAFT" | "ISSUED" | "CANCELLED";
  row_version: number; preview_hash: string; preview_payload: ProformaPreview; client_id: string; currency: string };
export async function lockProforma(tx: PoolClient, id: string, expectedVersion: number): Promise<LockedProforma> {
  const row = (await tx.query<LockedProforma>("SELECT id::text,reference,status,row_version,preview_hash,preview_payload,client_id,currency FROM public.proforma_client WHERE id=$1::uuid FOR UPDATE", [id])).rows[0];
  if (!row) throw new HttpError(404, "PROFORMA_NOT_FOUND", "Proforma introuvable.");
  if (row.row_version !== expectedVersion) throw new HttpError(409, "PROFORMA_VERSION_CHANGED", "La proforma a changé : actualisez son aperçu.");
  return row;
}

export async function repoCreateProforma(args: CommandContext & { input: ProformaCreateBodyDTO }): Promise<ProformaCommandResult> {
  return runProformaCommand({ ...args, commandType: "PROFORMA_DRAFT_CREATE", payload: args.input, work: async (tx, correlationId) => {
    // A draft consumes the legal-looking proforma sequence, therefore it is
    // subject to the same cutover suspension as issued fiscal documents.
    await assertFinancialCutoverEmissionAllowedTx(tx);
    const preview = await buildProformaPreview(tx, args.input, true);
    if (preview.preview_hash !== args.input.preview_hash) throw new HttpError(409, "PROFORMA_PREVIEW_CHANGED", "Les données de commande ont changé : actualisez l'aperçu.", { preview });
    const id = crypto.randomUUID();
    const seq = (await tx.query<{ value: string; year: string }>("SELECT nextval('public.proforma_client_reference_seq')::text AS value,to_char(CURRENT_DATE,'YYYY') AS year")).rows[0]!;
    const reference = `PF-${seq.year}-${seq.value.padStart(6, "0")}`;
    await tx.query(`INSERT INTO public.proforma_client(id,reference,client_id,currency,preview_hash,preview_payload,created_by,correlation_id)
      VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb,$7,$8::uuid)`, [id, reference, preview.client_id, preview.currency, preview.preview_hash, JSON.stringify(preview), args.actor.userId, correlationId]);
    await persistProformaDraftContentTx(tx, { id, reference, preview, actorId: args.actor.userId, correlationId });
    return { aggregateId: id, deliveryAllocationIds: preview.affairs.map(affair=>affair.allocation_id), result: { id, reference, status: "DRAFT" as const, row_version: 1 } };
  } });
}

export async function repoIssueProforma(args: CommandContext & { id: string; input: ProformaIssueBodyDTO }): Promise<ProformaCommandResult> {
  return runProformaCommand({ ...args, commandType: "PROFORMA_ISSUE", payload: { id: args.id, ...args.input }, work: async (tx) => {
    // Existing drafts must not bypass the suspension by being issued later.
    await assertFinancialCutoverEmissionAllowedTx(tx);
    const document = await lockProforma(tx, args.id, args.input.expected_version);
    if (document.status !== "DRAFT") throw new HttpError(409, "PROFORMA_NOT_DRAFT", "Cette proforma n'est plus un brouillon.");
    const current = await buildProformaPreview(tx, { client_id: document.client_id, currency: document.currency,
      affairs: document.preview_payload.affairs.map(affair => ({ allocation_id: affair.allocation_id,
        billing_parts: affair.billing_parts.map(part => ({ billed_client_id: part.billed_client_id, quantity: part.quantity })) })) }, true, document.id);
    if (current.preview_hash !== document.preview_hash || current.preview_hash !== args.input.preview_hash) {
      throw new HttpError(409, "PROFORMA_PREVIEW_CHANGED", "Les données commerciales ont changé : préparez une nouvelle version avant émission.", { preview: current });
    }
    const policy = (await tx.query<{ legal_entity_code: string }>(`SELECT legal_entity_code FROM public.finance_billing_policies WHERE active
      AND effective_from<=CURRENT_DATE AND (effective_to IS NULL OR effective_to>=CURRENT_DATE) ORDER BY effective_from DESC,created_at DESC LIMIT 1`)).rows[0];
    if (!policy) throw new HttpError(409, "PROFORMA_ISSUER_NOT_CONFIGURED", "Configurez l'émetteur commercial dans Finance.");
    const issuedAt = new Date().toISOString();
    const issuer = await issuerSnapshotAt(tx, policy.legal_entity_code, todayInParis());
    if (!issuer?.company_name) throw new HttpError(409, "PROFORMA_ISSUER_NOT_CONFIGURED", "Complétez les coordonnées de l'émetteur commercial.");
    const snapshot: ProformaDocumentSnapshot = { document_type: "PROFORMA", id: document.id, reference: document.reference, issued_at: issuedAt,
      issuer_snapshot: issuer, preview: current, fiscal_invoice_created: false, template_version: "proforma/1.1" };
    const bytes = await renderProformaDocument(snapshot);
    await tx.query(`UPDATE public.proforma_client SET status='ISSUED',issued_at=$2::timestamptz,issued_by=$3,
      issued_snapshot=$4::jsonb,row_version=row_version+1 WHERE id=$1::uuid`, [document.id, issuedAt, args.actor.userId, JSON.stringify(snapshot)]);
    const archive = await queueCreationPdfArchive(tx, { entityType: "proforma", entityId: document.id,
      documentKind: "CUSTOMER_PROFORMA", documentVersion: 1, renderVersion: "proforma/1.1+style-20261019",
      idempotencyKey: `proforma:${document.id}:issue:v1`, title: `Proforma ${document.reference}`,
      originalName: `PROFORMA_${document.reference}.pdf`, sourceRevision: financePreviewHash(snapshot),
      sourceSnapshot: { ...snapshot }, exactPdfBytes: bytes, actorUserId: args.actor.userId });
    return { aggregateId: document.id, deliveryAllocationIds: current.affairs.map(affair=>affair.allocation_id), oldValues: { status: document.status, row_version: document.row_version },
      result: { id: document.id, reference: document.reference, status: "ISSUED" as const, row_version: document.row_version + 1, document_archive_id: archive.id },
      newValues: { status: "ISSUED", source_hash: financePreviewHash(snapshot), document_archive_id: archive.id, fiscal_invoice_created: false } };
  } });
}

export async function repoDecideDeliveryPrepaymentTerms(args: CommandContext & { allocationId: number; input: DeliveryPrepaymentTermsBodyDTO }) {
  return runProformaCommand({ ...args, commandType: "PROFORMA_AFFAIR_TERMS_DECIDED", payload: { allocation_id: args.allocationId, ...args.input }, work: async (tx, correlationId) => {
    const [source] = await readProformaOrderSources(tx, [args.allocationId], true);
    if (!source || source.order_type === "INTERNE") throw new HttpError(409, "PROFORMA_AFFAIR_NOT_ELIGIBLE", "Sélectionnez une affaire de livraison client.");
    const version = source.terms_version ?? 0;
    if (version !== args.input.expected_version) throw new HttpError(409, "PROFORMA_TERMS_VERSION_CHANGED", "Les conditions de paiement ont changé : actualisez l'affaire.");
    if (source.bound_proforma_id && source.bound_proforma_status !== "CANCELLED") throw new HttpError(409, "PROFORMA_AFFAIR_ALREADY_BOUND", "Régularisez la proforma liée avant de changer les conditions de paiement.", { proforma_id: source.bound_proforma_id });
    const result = (await tx.query<{ row_version: number }>(`INSERT INTO public.delivery_affair_prepayment_terms
      (allocation_id,requirement,decision_reason,updated_by,correlation_id) VALUES($1,$2,$3,$4,$5::uuid)
      ON CONFLICT(allocation_id) DO UPDATE SET requirement=EXCLUDED.requirement,proforma_line_id=NULL,
        row_version=delivery_affair_prepayment_terms.row_version+1,decision_reason=EXCLUDED.decision_reason,
        updated_at=now(),updated_by=EXCLUDED.updated_by,correlation_id=EXCLUDED.correlation_id RETURNING row_version`,
      [args.allocationId, args.input.requirement, args.input.reason, args.actor.userId, correlationId])).rows[0]!;
    return { aggregateId: `affair-${args.allocationId}`, deliveryAllocationIds: [args.allocationId], oldValues: { requirement: source.prepayment_requirement ?? "UNCONFIRMED", row_version: version },
      result: { allocation_id: args.allocationId, requirement: args.input.requirement, row_version: result.row_version } };
  } });
}
