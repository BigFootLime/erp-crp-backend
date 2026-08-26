import crypto from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import { sendTransactionalEmail, type ResendSendResult } from "../../../shared/email/resend.service";
import { readIssuerParty } from "../../../shared/documents/issuer-identity.repository";
import {
  CONTENT_WIDTH,
  renderCerpDocument,
  type CerpLineRow,
} from "../../../shared/pdf/cerp-document";
import { money } from "../../../shared/pdf/format-fr";
import { issuerIdentityLine, issuerLegalMentions, type LegalParty } from "../../../shared/pdf/legal-mentions";
import type {
  CommandeArDraft,
  CommandeArRecipientSuggestion,
  CommandeArSendResult,
  CommandeArVersionsResult,
} from "../types/commande-ar.types";
import type { SendCommandeArBodyDTO } from "../validators/commande-ar.validators";
import {
  buildCommandeArRecipientSuggestions,
  repoAuthorizeCommandeArGeneration,
  repoClaimCommandeArSend,
  repoCreateCommandeArDraft,
  repoFindCommandeArOfficialArchiveId,
  repoFinalizeCommandeArSend,
  repoLoadCommandeArGenerationData,
  repoListCommandeArDrafts,
  repoMarkCommandeArFailed,
  repoResolveCommandeArOfficialArchive,
} from "../repository/commande-ar.repository";
import pool from "../../../config/database";
import type { AuthoritativePdfArchiveRecord } from "../../../shared/authoritative-documents/authoritative-document.types";
import { getOfficialDocumentGenerationEnvelope, getOfficialPdfDto, readOfficialPdfBytes, recordOfficialPdfPrintIntent } from "../../../shared/authoritative-documents/authoritative-document.service";
import {
  buildCommandeArContentSnapshot,
  isCommandeArSnapshotCurrent,
  sha256Canonical,
} from "../domain/commande-ar-fingerprint";

const ACKNOWLEDGEMENT_DOCUMENT_KIND = "CUSTOMER_ORDER_ACKNOWLEDGEMENT";

type CommandeArAddress = {
  name?: string | null;
  street?: string | null;
  house_number?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
};

export type CommandeArOfficialSnapshot = {
  type: "CUSTOMER_ORDER_ACKNOWLEDGEMENT";
  /** Assigned inside the locked creation transaction before archival. */
  acknowledgement_id?: string;
  acknowledgement_number: string;
  order_number: string;
  generated_at: string;
  status: string | null;
  customer_name: string | null;
  date_commande: string;
  total_ht: string;
  total_ttc: string;
  public_comment: string | null;
  bill_address: CommandeArAddress;
  delivery_address: CommandeArAddress;
  lines: Array<{ designation: string; code_piece: string | null; quantite: string; unite: string | null; prix_unitaire_ht: string; taux_tva: string | null; total_ttc: string }>;
  issuer: LegalParty;
};

function formatCurrencyEUR(value: number | string): string {
  return money(value, "EUR");
}

function formatDateFR(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR").format(date);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export { sha256Canonical } from "../domain/commande-ar-fingerprint";

export function renderCommandeArEmailHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 12px 0;line-height:1.5;">${escapeHtml(block).replace(/\n/g, "<br />")}</p>`)
    .join("");
  return `
    <div style="background:#f6f7fb;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:24px;">
        <div style="font-size:18px;font-weight:800;margin-bottom:14px;">Accusé de réception</div>
        ${paragraphs}
      </div>
    </div>
  `.trim();
}

type CommandeArEmailContact = {
  contact_id: string;
  civility: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

export function buildCommandeArEmailContent(params: {
  numero: string;
  customer_reference: string | null;
  reference: string;
  contact: CommandeArEmailContact | null;
  custom_message?: string | null;
}): { subject: string; text: string; html: string } {
  const contactName = params.contact
    ? [params.contact.civility, params.contact.first_name, params.contact.last_name].filter((part) => part?.trim()).join(" ").trim()
    : "";
  const greeting = contactName || "Madame, Monsieur";
  const customerReference = params.customer_reference?.trim() || params.numero;
  const lines = [
    `Bonjour ${greeting},`,
    "",
    `Nous vous confirmons la prise en compte de votre commande ${customerReference}, enregistrée dans CERP sous le numéro ${params.numero}.`,
    "",
    `Veuillez trouver en pièce jointe notre accusé de réception ${params.reference}.`,
  ];
  if (params.custom_message?.trim()) lines.push("", params.custom_message.trim());
  lines.push("", "Cordialement,", "Croix Rousse Précision");
  const text = lines.join("\n");
  return {
    subject: `Accusé de réception de votre commande ${params.numero} — ${params.reference}`,
    text,
    html: renderCommandeArEmailHtml(text),
  };
}

function addressLines(address: CommandeArAddress): string[] {
  const lines = [
    address.name ?? "",
    [address.house_number ?? "", address.street ?? ""].filter(Boolean).join(" ").trim(),
    [address.postal_code ?? "", address.city ?? ""].filter(Boolean).join(" ").trim(),
    address.country ?? "",
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return lines.length ? lines : ["-"];
}

function subjectForCommande(numero: string): string {
  return `Accusé de réception ${numero}`;
}

function bodyTextForCommande(params: { numero: string; companyName: string | null }): string {
  const company = params.companyName?.trim() || "Madame, Monsieur";
  return [
    `Bonjour ${company},`,
    "",
    `Nous vous confirmons la bonne réception de votre commande ${params.numero}.`,
    "Vous trouverez en pièce jointe l’accusé de réception préparé par notre ERP.",
    "",
    "Cordialement,",
    "Croix-Rousse Précision",
  ].join("\n");
}

function buildEmailHtml(text: string, customMessage?: string | null): string {
  const paragraphs = text.split(/\n{2,}/).map((block) => `<p style=\"margin:0 0 12px 0;line-height:1.5;\">${escapeHtml(block).replace(/\n/g, "<br />")}</p>`);
  const extra = customMessage?.trim()
    ? `<div style=\"margin-top:16px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;\">${escapeHtml(customMessage.trim()).replace(/\n/g, "<br />")}</div>`
    : "";
  return `
    <div style="background:#f6f7fb;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:24px;">
        <div style="font-size:18px;font-weight:800;margin-bottom:14px;">Accuse de reception</div>
        ${paragraphs.join("")}
        ${extra}
      </div>
    </div>
  `.trim();
}

function isResendSendError(result: Extract<ResendSendResult, { ok: false }>): result is { ok: false; error: string } {
  return "error" in result;
}

async function waitForCommandeArOfficialArchiveId(
  commandeId: number,
  arId: string,
  attempts = 20,
  delayMs = 250
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const archiveId = await repoFindCommandeArOfficialArchiveId(commandeId, arId);
    if (archiveId) return archiveId;
    if (attempt < attempts - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

export async function buildCommandeArPdfBuffer(params: {
  reference?: string;
  draftNumber: string;
  /** Customer order reference; distinct from the acknowledgement number when configured. */
  orderNumber?: string;
  companyName: string | null;
  dateCommande: string;
  generatedAt?: Date;
  /** Persisted authoritative archive edition (not PDF renderer/template version). */
  documentVersion?: number;
  statut: string | null;
  totalHt: number | string;
  totalTtc: number | string;
  commentaire: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  billAddress: CommandeArAddress;
  deliveryAddress: CommandeArAddress;
  lines: Array<{
    designation: string;
    code_piece: string | null;
    quantite: number | string;
    unite: string | null;
    prix_unitaire_ht: number | string;
    taux_tva: number | string | null;
    total_ttc: number | string;
  }>;
  /**
   * Instantane de l'emetteur : identite legale et mentions obligatoires.
   *
   * L'accuse de reception est un document commercial envoye au client par courriel : il
   * doit porter l'identite legale de son emetteur au meme titre que la facture et le bon de
   * livraison (art. R123-237 C. com.). Il ne portait aucune mention.
   */
  issuer?: LegalParty;
}): Promise<Buffer> {
  const clientName = params.companyName?.trim() || "Client";
  const orderNumber = params.orderNumber?.trim() || params.draftNumber;
  const reference = params.reference?.trim() || params.draftNumber;
  const generatedAt = params.generatedAt ?? new Date();
  const issuer = params.issuer ?? await readIssuerParty({ at: generatedAt.toISOString().slice(0, 10) });
  const draft = params.statut?.trim().toUpperCase() === "BROUILLON";
  const rows: CerpLineRow[] = params.lines.map((line) => ({
    cells: {
      designation: line.designation,
      code_piece: line.code_piece ?? "—",
      quantite: String(line.quantite),
      unite: line.unite ?? "—",
      prix_unitaire_ht: formatCurrencyEUR(line.prix_unitaire_ht),
      taux_tva: `${line.taux_tva ?? 0} %`,
      total_ttc: formatCurrencyEUR(line.total_ttc),
    },
    metaColumn: "designation",
  }));

  return renderCerpDocument(
    {
      documentType: "Accusé de réception",
      name: clientName,
      code: reference,
      subtitle: `Version ${params.documentVersion ?? 1} · Commande ${orderNumber}`,
      status: params.statut ?? "PLANIFIEE",
      flag: draft ? "INTERNE / BROUILLON" : null,
      watermark: draft ? "INTERNE / BROUILLON" : null,
      monogramName: clientName,
      generatedAt: formatDateFR(generatedAt.toISOString()),
      title: `Accusé de réception ${reference}`,
      subject: draft ? "Instantané interne CERP — brouillon" : "Accusé de réception de commande CERP",
      footerNote: draft ? "Instantané interne GED — non opposable" : null,
      legalIdentity: issuerIdentityLine(issuer),
      legalMentions: issuerLegalMentions(issuer),
      creationDate: generatedAt,
    },
    (ctx) => {
      ctx.legalStrip([
        { label: "Commande", value: orderNumber },
        { label: "Date commande", value: formatDateFR(params.dateCommande) },
        { label: "Statut", value: params.statut ?? "PLANIFIEE" },
        { label: "Total TTC", value: formatCurrencyEUR(params.totalTtc) },
      ]);

      ctx.section("Client et adresses", { cohesion: 100 });
      ctx.addressCards([
        {
          caption: "Facturation",
          lines: addressLines(params.billAddress),
          accent: true,
        },
        {
          caption: "Livraison",
          lines: addressLines(params.deliveryAddress),
        },
      ]);

      ctx.section("Contact", { cohesion: 36 });
      const half = CONTENT_WIDTH / 2 - 8;
      const emailBottom = ctx.field("Email", params.clientEmail, 38, half);
      const phoneBottom = ctx.field("Téléphone", params.clientPhone, 38 + half + 16, half);
      ctx.y = Math.max(emailBottom, phoneBottom);

      ctx.section("Lignes de commande", { cohesion: 84 });
      ctx.linesTable({
        columns: [
          { key: "designation", label: "Désignation", flex: 4.5 },
          { key: "code_piece", label: "Code pièce", flex: 1.8 },
          { key: "quantite", label: "Qté", flex: 1, align: "right" },
          { key: "unite", label: "Unité", flex: 1 },
          { key: "prix_unitaire_ht", label: "PU HT", flex: 1.8, align: "right" },
          { key: "taux_tva", label: "TVA", flex: 1.2, align: "right" },
          { key: "total_ttc", label: "Total TTC", flex: 2, align: "right" },
        ],
        rows,
        emptyLabel: "Aucune ligne sur cette commande.",
      });

      ctx.section("Totaux", { cohesion: 32 });
      const totalHtBottom = ctx.field("Total HT", formatCurrencyEUR(params.totalHt), 38, half);
      const totalTtcBottom = ctx.field(
        "Total TTC",
        formatCurrencyEUR(params.totalTtc),
        38 + half + 16,
        half
      );
      ctx.y = Math.max(totalHtBottom, totalTtcBottom);

      if (params.commentaire?.trim()) {
        ctx.notesSection("Notes", params.commentaire.trim());
      }
    }
  );
}

/** Renderer registered in the authoritative worker. It consumes the frozen source only. */
export async function renderCommandeArOfficialPdf({ archive }: { archive: AuthoritativePdfArchiveRecord }): Promise<Buffer> {
  const source = archive.sourceSnapshot as Partial<CommandeArOfficialSnapshot>;
  if (source.type !== "CUSTOMER_ORDER_ACKNOWLEDGEMENT" || !source.acknowledgement_number || !Array.isArray(source.lines) || !source.issuer) {
    throw new Error("COMMANDE_AR_OFFICIAL_SNAPSHOT_INVALID");
  }
  const archivedAt = new Date(archive.createdAt);
  if (Number.isNaN(archivedAt.getTime())) throw new Error("COMMANDE_AR_ARCHIVE_CREATED_AT_INVALID");
  return buildCommandeArPdfBuffer({
    issuer: source.issuer, draftNumber: source.acknowledgement_number, orderNumber: source.order_number,
    companyName: source.customer_name ?? null,
    // `generated_at` remains inside the frozen business snapshot; the document
    // artifact's header/footer/PDF metadata are the immutable archive time.
    dateCommande: source.date_commande ?? "", generatedAt: archivedAt, statut: source.status ?? null,
    documentVersion: archive.documentVersion,
    totalHt: source.total_ht ?? "0", totalTtc: source.total_ttc ?? "0", commentaire: source.public_comment ?? null,
    clientEmail: null, clientPhone: null, billAddress: source.bill_address ?? {}, deliveryAddress: source.delivery_address ?? {},
    lines: source.lines.map((line) => ({ designation: line.designation, code_piece: line.code_piece ?? null, quantite: line.quantite, unite: line.unite ?? null, prix_unitaire_ht: line.prix_unitaire_ht, taux_tva: line.taux_tva, total_ttc: line.total_ttc })),
  });
}

export async function svcGenerateCommandeAr(params: {
  commande_id: number;
  user_id: number;
  user_role: string | null | undefined;
  source_revision?: string | null;
  reissue_reason?: string | null;
  idempotency_key?: string | null;
}): Promise<CommandeArDraft> {
  const client = await pool.connect();
  try {
    await repoAuthorizeCommandeArGeneration({
      tx: client,
      commande_id: params.commande_id,
      user_id: params.user_id,
      user_role: params.user_role,
    });
    const data = await repoLoadCommandeArGenerationData(client, params.commande_id);
    if (!data) {
      throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable");
    }
    const recipientSuggestions = buildCommandeArRecipientSuggestions(data);

    const generatedAt = new Date();
    // An acknowledgement is fixed by the generated PDF. It carries the legal version in
    // force when that artifact is created, not the possibly much older order date.
    const issuer = await readIssuerParty({ at: generatedAt.toISOString().slice(0, 10) });

    const officialSnapshot: CommandeArOfficialSnapshot = {
      type: "CUSTOMER_ORDER_ACKNOWLEDGEMENT", acknowledgement_number: data.header.numero, order_number: data.header.numero,
      generated_at: generatedAt.toISOString(), status: data.header.statut, customer_name: data.header.client_company_name,
      date_commande: data.header.date_commande, total_ht: String(data.header.total_ht), total_ttc: String(data.header.total_ttc),
      public_comment: data.header.commentaire, bill_address: { name: data.header.bill_name, street: data.header.bill_street, house_number: data.header.bill_house_number, postal_code: data.header.bill_postal_code, city: data.header.bill_city, country: data.header.bill_country },
      delivery_address: { name: data.header.deliv_name, street: data.header.deliv_street, house_number: data.header.deliv_house_number, postal_code: data.header.deliv_postal_code, city: data.header.deliv_city, country: data.header.deliv_country },
      lines: data.lines.map((line) => ({ designation: line.designation, code_piece: line.code_piece, quantite: String(line.quantite), unite: line.unite, prix_unitaire_ht: String(line.prix_unitaire_ht), taux_tva: line.taux_tva == null ? null : String(line.taux_tva), total_ttc: String(line.total_ttc) })), issuer,
    };
    const contentSnapshot = buildCommandeArContentSnapshot(data);
    const contentFingerprint = sha256Canonical(contentSnapshot);
    const defaultContact = recipientSuggestions.filter((suggestion) => suggestion.is_default && suggestion.contact_id).length === 1
      ? data.contacts.find((contact) => contact.contact_id === recipientSuggestions.find((suggestion) => suggestion.is_default)?.contact_id) ?? null
      : null;
    const draft = await repoCreateCommandeArDraft({
      commande_id: params.commande_id,
      user_id: params.user_id,
      user_role: params.user_role,
      document_name: `AR-${data.header.numero}.pdf`,
      pdf_buffer: Buffer.alloc(0),
      pdf_factory: ({ reference, version_number }) => buildCommandeArPdfBuffer({
        reference,
        issuer,
        draftNumber: data.header.numero,
        orderNumber: data.header.customer_reference ?? data.header.numero,
        companyName: data.header.client_company_name,
        dateCommande: data.header.date_commande,
        generatedAt,
        documentVersion: version_number,
        statut: data.header.statut,
        totalHt: data.header.total_ht,
        totalTtc: data.header.total_ttc,
        commentaire: data.header.commentaire,
        clientEmail: data.header.client_email,
        clientPhone: data.header.client_phone,
        billAddress: officialSnapshot.bill_address,
        deliveryAddress: officialSnapshot.delivery_address,
        lines: data.lines,
      }),
      subject: "",
      body_text: "",
      subject_factory: ({ reference }) => buildCommandeArEmailContent({
        numero: data.header.numero,
        customer_reference: data.header.customer_reference,
        reference,
        contact: defaultContact,
      }).subject,
      body_text_factory: ({ reference }) => buildCommandeArEmailContent({
        numero: data.header.numero,
        customer_reference: data.header.customer_reference,
        reference,
        contact: defaultContact,
      }).text,
      recipient_suggestions: recipientSuggestions,
      content_fingerprint: contentFingerprint,
      content_snapshot: contentSnapshot,
      force_new_version: Boolean(params.reissue_reason?.trim()),
      official_source_snapshot: officialSnapshot,
      official_request_idempotency_key: params.idempotency_key ?? undefined,
      official_expected_source_revision: params.source_revision ?? undefined,
      official_reissue_reason: params.reissue_reason ?? undefined,
    });

    return {
      ar_id: draft.ar_id,
      commande_id: params.commande_id,
      document_id: draft.document_id,
      document_name: draft.document_name,
      reference: draft.reference,
      series_number: draft.series_number,
      version_number: draft.version_number,
      subject: draft.subject,
      default_message: draft.body_text?.trim() || "",
      generated_at: draft.generated_at,
      generated_by: draft.generated_by,
      status: draft.status,
      sent_at: draft.sent_at,
      preview_path: draft.preview_path,
      is_obsolete: false,
      reused_draft: false,
      recipient_suggestions: recipientSuggestions,
    };
  } finally {
    client.release();
  }
}

export async function svcSendCommandeAr(params: {
  commande_id: number;
  user_id: number;
  user_role?: string | null;
  body: SendCommandeArBodyDTO;
}): Promise<CommandeArSendResult> {
  const recipientEmails = params.body.recipient_emails.map((email) => email.trim().toLowerCase());
  const recipientContactIds = [...params.body.recipient_contact_ids];
  const payloadFingerprint = sha256Canonical({
    recipient_emails: [...recipientEmails].sort(),
    recipient_contact_ids: [...recipientContactIds].sort(),
    email_body: params.body.email_body?.trim() || null,
    message: params.body.message?.trim() || null,
  });
  const claimResult = await repoClaimCommandeArSend({
    commande_id: params.commande_id,
    ar_id: params.body.ar_id,
    user_id: params.user_id,
    user_role: params.user_role,
    recipient_emails: recipientEmails,
    recipient_contact_ids: recipientContactIds,
    idempotency_key: params.body.idempotency_key ?? null,
    payload_fingerprint: payloadFingerprint,
  });
  if (claimResult.kind === "already_sent") return claimResult.result;

  const claim = claimResult;
  const draft = claim.draft;
  try {
    // The supplier/customer-facing email must attach the exact archived GED
    // bytes, never a mutable legacy working-file copy.
    // The authoritative worker archives the immutable GED rendition just
    // after draft creation. A user can legitimately confirm the prepared
    // dialog before that short background step finishes, so wait briefly for
    // the exact archive instead of returning a misleading immediate failure.
    const archiveId = await waitForCommandeArOfficialArchiveId(params.commande_id, draft.ar_id);
    if (!archiveId) throw new HttpError(409, "OFFICIAL_DOCUMENT_NOT_READY", "Le document officiel est en cours de génération.");
    const archived = await readOfficialPdfBytes({
      entityType: "commande-client", entityId: String(params.commande_id), archiveId,
      documentKind: ACKNOWLEDGEMENT_DOCUMENT_KIND,
      actorUserId: params.user_id, eventType: "AUTHORITATIVE_PDF_SENT",
    });
    const archivedHash = crypto.createHash("sha256").update(archived.bytes).digest("hex");
    if (!draft.pdf_sha256 || archivedHash !== draft.pdf_sha256) {
      throw new HttpError(409, "COMMANDE_AR_PDF_INTEGRITY_ERROR", "Le PDF officiel archivé ne correspond pas à la version préparée.");
    }

    const snapshot = draft.content_snapshot as { header?: { numero?: unknown; customer_reference?: unknown } } | null;
    const numero = typeof snapshot?.header?.numero === "string" ? snapshot.header.numero.trim() : "";
    if (!numero) {
      throw new HttpError(409, "COMMANDE_AR_SNAPSHOT_INVALID", "Le contenu figé de cet accusé de réception est incomplet.");
    }
    const customerReference = typeof snapshot?.header?.customer_reference === "string"
      ? snapshot.header.customer_reference
      : null;
    const selectedContact = claim.contacts.length === 1 ? claim.contacts[0] : null;
    const emailBodyOverride = params.body.email_body?.trim() || null;
    const generatedContent = buildCommandeArEmailContent({
      numero,
      customer_reference: customerReference,
      reference: draft.reference,
      contact: selectedContact,
      custom_message: emailBodyOverride ? null : params.body.message,
    });
    // `email_body` is the complete operator-reviewed text exposed by the
    // preparation dialog. Older callers use `message`, which is inserted in
    // the canonical versioned content before the signature.
    const sentText = emailBodyOverride ?? generatedContent.text;
    const sentHtml = emailBodyOverride ? renderCommandeArEmailHtml(emailBodyOverride) : generatedContent.html;

    const emailResult = await sendTransactionalEmail({
      to: recipientEmails,
      subject: generatedContent.subject,
      text: sentText,
      html: sentHtml,
      idempotencyKey: claim.idempotency_key,
      attachments: [
        {
          filename: archived.filename,
          content: archived.bytes,
          contentType: "application/pdf",
        },
      ],
    });

    if (!emailResult.ok) {
      let statusCode = 502;
      let message = "Erreur d'envoi de l'email";
      if ("skipped" in emailResult && emailResult.skipped === true) {
        statusCode = 503;
        message = "Email non configuré sur le serveur";
      } else if (isResendSendError(emailResult)) {
        message = emailResult.error;
      }
      throw new HttpError(statusCode, "COMMANDE_AR_SEND_FAILED", message);
    }

    const finalized = await repoFinalizeCommandeArSend({
      commande_id: params.commande_id,
      ar_id: params.body.ar_id,
      send_lock_token: claim.lock_token,
      sent_by: params.user_id,
      recipient_emails: recipientEmails,
      recipient_contact_ids: recipientContactIds,
      email_provider_id: emailResult.id ?? null,
      provider_name: "resend",
      sent_email_subject: generatedContent.subject,
      sent_email_text: sentText,
      sent_email_html: sentHtml,
      commentaire: `AR envoyé à ${recipientEmails.join(", ")}`,
    });

    return finalized.result;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Échec de l'envoi de l'AR";
    await Promise.resolve(repoMarkCommandeArFailed({
      commande_id: params.commande_id,
      ar_id: params.body.ar_id,
      send_lock_token: claim.lock_token,
      error_message: errorMessage,
      user_id: params.user_id,
      provider_name: "resend",
    })).catch(() => undefined);
    throw err;
  }
}

export async function svcListCommandeArVersions(params: {
  commande_id: number;
  user_id: number;
  user_role?: string | null;
}): Promise<CommandeArVersionsResult> {
  await repoAuthorizeCommandeArGeneration({
    tx: pool,
    commande_id: params.commande_id,
    user_id: params.user_id,
    user_role: params.user_role,
  });
  const data = await repoLoadCommandeArGenerationData(pool, params.commande_id);
  if (!data) throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable");

  const contentSnapshot = buildCommandeArContentSnapshot(data);
  const recipientSuggestions = buildCommandeArRecipientSuggestions(data);
  const versions = (await repoListCommandeArDrafts({ commande_id: params.commande_id })).map((draft) => ({
    ar_id: draft.ar_id,
    commande_id: draft.commande_id,
    document_id: draft.document_id,
    document_name: draft.document_name,
    reference: draft.reference,
    series_number: draft.series_number,
    version_number: draft.version_number,
    subject: draft.subject,
    default_message: draft.body_text?.trim() || "",
    generated_at: draft.generated_at,
    generated_by: draft.generated_by,
    status: draft.status,
    sent_at: draft.sent_at,
    preview_path: draft.preview_path,
    is_obsolete: !isCommandeArSnapshotCurrent({
      storedSnapshot: draft.content_snapshot,
      storedFingerprint: draft.content_fingerprint,
      currentSnapshot: contentSnapshot,
    }),
    reused_draft: false,
    recipient_suggestions: recipientSuggestions,
  }));
  const current = versions.find((version) => version.status === "GENERATED" && !version.is_obsolete) ?? versions[0] ?? null;
  return { current, versions };
}

export async function svcCreateCommandeArOfficial(params: {
  commande_id: number; user_id: number; user_role: string | null | undefined; source_revision: string; reissue_reason?: string | null; idempotency_key: string;
}) {
  // The repository performs source freshness and reissue checks while holding
  // the command row lock, after handling a same-key replay.
  const draft = await svcGenerateCommandeAr(params);
  return getOfficialDocumentGenerationEnvelope({
    tx: pool, entityType: "commande-client", entityId: String(draft.commande_id), documentKind: ACKNOWLEDGEMENT_DOCUMENT_KIND, baseUrl: acknowledgementBase(params.commande_id),
  });
}

const acknowledgementBase = (commandeId: number) => `/commandes/${commandeId}/acknowledgements`;

export async function svcListCommandeArOfficialDocuments(commandeId: number) {
  return getOfficialDocumentGenerationEnvelope({
    tx: pool, entityType: "commande-client", entityId: String(commandeId), documentKind: ACKNOWLEDGEMENT_DOCUMENT_KIND, baseUrl: acknowledgementBase(commandeId),
  });
}

async function resolveAcknowledgementArchive(commandeId: number, archiveId: string): Promise<string> {
  const arId = await repoResolveCommandeArOfficialArchive(commandeId, archiveId);
  if (!arId) throw new HttpError(404, "OFFICIAL_DOCUMENT_NOT_FOUND", "Document officiel introuvable.");
  return arId;
}

export async function svcGetCommandeArOfficialDocument(commandeId: number, archiveId: string) {
  return getOfficialPdfDto({ tx: pool, entityType: "commande-client", entityId: String(commandeId), documentKind: ACKNOWLEDGEMENT_DOCUMENT_KIND, archiveId, baseUrl: acknowledgementBase(commandeId) });
}

export async function svcReadCommandeArOfficialDocument(commandeId: number, archiveId: string, actorUserId: number, eventType: "AUTHORITATIVE_PDF_PREVIEWED" | "AUTHORITATIVE_PDF_DOWNLOADED") {
  return readOfficialPdfBytes({ entityType: "commande-client", entityId: String(commandeId), documentKind: ACKNOWLEDGEMENT_DOCUMENT_KIND, archiveId, actorUserId, eventType });
}

export async function svcRecordCommandeArOfficialPrint(commandeId: number, archiveId: string, actorUserId: number) {
  return recordOfficialPdfPrintIntent({ entityType: "commande-client", entityId: String(commandeId), documentKind: ACKNOWLEDGEMENT_DOCUMENT_KIND, archiveId, actorUserId });
}

export async function svcSendCommandeArOfficial(params: {
  commande_id: number; archive_id: string; user_id: number; user_role: string | null | undefined; body: Omit<SendCommandeArBodyDTO, "ar_id">;
}): Promise<CommandeArSendResult> {
  const arId = await resolveAcknowledgementArchive(params.commande_id, params.archive_id);
  return svcSendCommandeAr({ ...params, body: { ...params.body, ar_id: arId } });
}
