import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { repoGetAuthoritativePdf } from "../../../shared/authoritative-documents/authoritative-document.repository";
import {
  getOfficialDocumentGenerationEnvelope,
  readOfficialPdfBytes,
} from "../../../shared/authoritative-documents/authoritative-document.service";
import { readArchivedGeneralTerms } from "../../../shared/commercial-terms/commercial-terms.service";
import { readCommercialEmailSetting } from "../../../shared/email/commercial-email-settings.repository";
import { sendTransactionalEmail } from "../../../shared/email/resend.service";
import { HttpError } from "../../../utils/httpError";
import { roleHasCommandeFournisseurCapability } from "../domain/commande-fournisseur-rbac";
import { canResumeSupplierOrderTestPdf, readCurrentSupplierTestArchive } from "./supplier-order-test-pdf.service";
import { repoTransitionCommandeFournisseur, type AuditContext } from "../repository/commande-fournisseur.repository";
import type { SupplierOrderEmailBodyDTO } from "../validators/commande-fournisseur.validators";

const scope = "commande-fournisseur";
const documentKind = "SUPPLIER_PURCHASE_ORDER";
const validAddress = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
type Queryer = Pick<PoolClient, "query">;
type Order = {
  code: string;
  statut: string;
  supplier_email: string | null;
  test_email: string | null;
  frozen_document_id: string | null;
  intercompany: boolean;
};
type EmailPreview = {
  mode: "test" | "production";
  status: "disabled" | "missing_recipient" | "preparing_document" | "document_failed" | "ready";
  recipient: string | null;
  archive_id: string | null;
  can_resume_pdf?: true;
};

function assertSendPermission(audit: AuditContext) {
  if (!roleHasCommandeFournisseurCapability(audit.role, "send"))
    throw new HttpError(403, "FORBIDDEN_TRANSITION", "Votre rôle ne permet pas l’envoi de ce bon.");
}

async function prepare(tx: Queryer, id: string, actor: number): Promise<{ preview: EmailPreview; code: string }> {
  const { rows: [order] } = await tx.query<Order>(
    `SELECT cf.code, cf.statut, f.email AS supplier_email, cd.id::text AS frozen_document_id,
            EXISTS (SELECT 1 FROM public.intercompany_purchase_order_links WHERE buyer_purchase_order_id = cf.id) AS intercompany,
            CASE WHEN u.directory_profile_id IS NOT NULL THEN u.directory_email ELSE u.email END AS test_email
       FROM public.commande_fournisseur cf
       JOIN public.fournisseurs f ON f.id = cf.fournisseur_id
       LEFT JOIN public.users u ON u.id = $2 AND u.status = 'Active'
       LEFT JOIN public.commande_fournisseur_document cd ON cd.commande_id = cf.id AND cd.version = cf.version_document
      WHERE cf.id = $1::uuid`,
    [id, actor],
  );
  if (!order) throw new HttpError(404, "COMMANDE_FOURNISSEUR_NOT_FOUND", "Commande fournisseur introuvable.");
  if (order.statut !== "APPROUVEE")
    throw new HttpError(409, "SUPPLIER_EMAIL_ORDER_NOT_APPROVED", "Le bon doit être approuvé avant l’envoi.");
  if (order.intercompany)
    throw new HttpError(409, "SUPPLIER_EMAIL_INTERCOMPANY", "Ce bon suit le circuit interentreprises.");

  const setting = await readCommercialEmailSetting(tx);
  const mode = setting.mode === "test" ? "test" : "production";
  const preview: EmailPreview = { mode, status: "disabled", recipient: null, archive_id: null };
  const result = { preview, code: order.code };
  if (!setting.value_json.enabled) return result;
  const recipient = (mode === "test" ? order.test_email : order.supplier_email)?.trim().toLowerCase();
  if (!recipient || recipient.length > 254 || !validAddress.test(recipient)) {
    preview.status = "missing_recipient";
    return result;
  }
  preview.recipient = recipient;

  const documents = await getOfficialDocumentGenerationEnvelope({
    tx, entityType: scope, entityId: id, documentKind,
    baseUrl: `/commandes-fournisseurs/${id}/official-documents`,
  });
  preview.status = documents.state === "PENDING" || documents.state === "PROCESSING"
    ? "preparing_document"
    : "document_failed";
  if (documents.state !== "READY" || !documents.latest_document || !order.frozen_document_id) {
    if (mode === "test" && order.frozen_document_id && documents.state !== "NOT_GENERATED" &&
      canResumeSupplierOrderTestPdf() && await readCurrentSupplierTestArchive(tx, id, order.frozen_document_id))
      preview.can_resume_pdf = true;
    return result;
  }
  const archive = await repoGetAuthoritativePdf(tx, scope, id, documents.latest_document.id, documentKind);
  const freeze = archive?.sourceSnapshot.frozen_document as { id?: string } | undefined;
  if (freeze?.id !== order.frozen_document_id) return result;
  preview.status = "ready";
  preview.archive_id = documents.latest_document.id;
  return result;
}

export async function previewSupplierOrderEmail(id: string, audit: AuditContext) {
  assertSendPermission(audit);
  return (await prepare(pool, id, audit.user_id)).preview;
}

function verifyIntent(preview: EmailPreview, input: SupplierOrderEmailBodyDTO) {
  if (preview.status === "disabled")
    throw new HttpError(409, "COMMERCIAL_EMAIL_DISABLED", "L’envoi des mails commerciaux est désactivé.");
  if (preview.status !== "ready" || preview.archive_id !== input.archive_id || preview.recipient !== input.expected_recipient)
    throw new HttpError(409, "SUPPLIER_EMAIL_PREPARATION_CHANGED", "Le document ou le destinataire a changé. Rouvrez la préparation de l’envoi.");
}

type Dispatch = { intent_hash: string; provider_id: string | null };
async function dispatchFor(tx: Queryer, id: string): Promise<Dispatch | undefined> {
  return (await tx.query<Dispatch>(
    "SELECT intent_hash, provider_id FROM public.supplier_order_email_dispatch WHERE order_id = $1::uuid",
    [id],
  )).rows[0];
}

function replayDispatch(existing: Dispatch, hash: string) {
  if (existing.provider_id && existing.intent_hash === hash)
    return { statut: "ENVOYEE" as const, idempotent_replay: true };
  throw new HttpError(409, "SUPPLIER_EMAIL_RECONCILIATION_REQUIRED",
    "Un envoi a déjà été tenté. Vérifiez la preuve de remise avant une nouvelle action.");
}

export async function sendSupplierOrderEmail(id: string, input: SupplierOrderEmailBodyDTO, audit: AuditContext) {
  assertSendPermission(audit);
  const hash = createHash("sha256").update(JSON.stringify([
    id, input.archive_id, input.expected_recipient, input.expected_updated_at, audit.user_id,
  ])).digest("hex");
  const existing = await dispatchFor(pool, id);
  if (existing) return replayDispatch(existing, hash);

  const { preview, code } = await prepare(pool, id, audit.user_id);
  verifyIntent(preview, input);
  const pdf = await readOfficialPdfBytes({
    entityType: scope, entityId: id, documentKind, archiveId: input.archive_id,
    actorUserId: audit.user_id, eventType: "AUTHORITATIVE_PDF_PREVIEWED",
  });
  const terms = await readArchivedGeneralTerms({
    scope, entityId: id, archiveId: input.archive_id, documentKind, actor: audit.user_id,
  });

  const client = await pool.connect();
  let reserved = false;
  let transportStarted = false;
  try {
    const claim = await client.query(
      `INSERT INTO public.supplier_order_email_dispatch(order_id, intent_hash, actor_id)
       VALUES ($1::uuid, $2, $3) ON CONFLICT (order_id) DO NOTHING`,
      [id, hash, audit.user_id],
    );
    if (!claim.rowCount) {
      const concurrent = await dispatchFor(client, id);
      if (concurrent) return replayDispatch(concurrent, hash);
      throw new HttpError(409, "SUPPLIER_EMAIL_RETRY_REQUIRED", "Rouvrez la préparation de l’envoi.");
    }
    reserved = true;

    const transition = await repoTransitionCommandeFournisseur(id, {
      to: "ENVOYEE", expected_updated_at: input.expected_updated_at,
    }, audit, {
      client,
      beforeSend: async tx => {
        const current = (await prepare(tx, id, audit.user_id)).preview;
        verifyIntent(current, input);
        const to = input.expected_recipient;
        transportStarted = true;
        const delivery = await sendTransactionalEmail({
          to: [to],
          testSenderEmail: current.mode === "test" ? to : undefined,
          subject: `Bon de commande fournisseur ${code}`,
          text: "Bonjour, veuillez trouver notre bon de commande en pièce jointe.",
          html: "<p>Bonjour, veuillez trouver notre bon de commande en pièce jointe.</p>",
          idempotencyKey: `supplier-po-${hash}`,
          timeoutMs: 8_000,
          attachments: [
            { filename: pdf.filename, content: pdf.bytes, contentType: "application/pdf" },
            ...(terms ? [{ filename: terms.filename, content: terms.bytes, contentType: "application/pdf" }] : []),
          ],
        });
        if (!delivery.ok && "skipped" in delivery) {
          transportStarted = false;
          throw new HttpError(503, "SUPPLIER_EMAIL_PROVIDER_UNAVAILABLE", "Le service de messagerie n’est pas configuré.");
        }
        if (!delivery.ok || !delivery.id)
          throw new HttpError(502, "SUPPLIER_EMAIL_SEND_FAILED", "La remise du bon n’a pas été confirmée.");
        await tx.query(
          `UPDATE public.supplier_order_email_dispatch SET provider_id = $3, delivered_at = now()
            WHERE order_id = $1::uuid AND intent_hash = $2`,
          [id, hash, delivery.id],
        );
        return { archive_id: input.archive_id, provider_id: delivery.id };
      },
    });
    if (transition.idempotent_replay)
      throw new HttpError(409, "SUPPLIER_EMAIL_ORDER_NOT_APPROVED", "Le statut du bon a changé avant l’envoi.");
    return transition;
  } finally {
    try {
      // Retain an ambiguous transport attempt across a rollback rather than sending twice.
      if (reserved && !transportStarted) await client.query(
        "DELETE FROM public.supplier_order_email_dispatch WHERE order_id = $1::uuid AND intent_hash = $2 AND provider_id IS NULL",
        [id, hash],
      );
    } finally {
      client.release();
    }
  }
}
