import fs from "node:fs/promises";
import path from "node:path";

import { HttpError } from "../../../utils/httpError";
import { getDocumentStoragePath } from "../../../utils/cerpStorage";
import { emitAppNotificationCreated, emitEntityChanged } from "../../../shared/realtime/realtime.service";
import { sendTransactionalEmail, type ResendSendResult } from "../../../shared/email/resend.service";
import { readIssuerParty } from "../../../shared/documents/issuer-identity.repository";
import {
  CONTENT_WIDTH,
  renderCerpDocument,
  type CerpLineRow,
} from "../../../shared/pdf/cerp-document";
import { issuerIdentityLine, issuerLegalMentions, type LegalParty } from "../../../shared/pdf/legal-mentions";
import type {
  CommandeArDraft,
  CommandeArRecipientSuggestion,
  CommandeArSendResult,
} from "../types/commande-ar.types";
import type { SendCommandeArBodyDTO } from "../validators/commande-ar.validators";
import {
  buildCommandeArRecipientSuggestions,
  repoAbortCommandeArSendClaim,
  repoAuthorizeCommandeArGeneration,
  repoClaimCommandeArSend,
  repoCreateCommandeArDraft,
  repoFinalizeCommandeArSend,
  repoLoadCommandeArGenerationData,
  repoMarkCommandeArFailed,
} from "../repository/commande-ar.repository";
import pool from "../../../config/database";

type CommandeArAddress = {
  name?: string | null;
  street?: string | null;
  house_number?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
};

function formatCurrencyEUR(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
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
  return `Accuse de reception ${numero}`;
}

function bodyTextForCommande(params: { numero: string; companyName: string | null }): string {
  const company = params.companyName?.trim() || "Madame, Monsieur";
  return [
    `Bonjour ${company},`,
    "",
    `Nous vous confirmons la bonne reception de votre commande ${params.numero}.`,
    "Vous trouverez en piece jointe l'accuse de reception genere par l'ERP.",
    "",
    "Cordialement,",
    "Croix Rousse Precision",
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

export async function buildCommandeArPdfBuffer(params: {
  draftNumber: string;
  companyName: string | null;
  dateCommande: string;
  generatedAt: Date;
  statut: string | null;
  totalHt: number;
  totalTtc: number;
  commentaire: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  billAddress: CommandeArAddress;
  deliveryAddress: CommandeArAddress;
  lines: Array<{
    designation: string;
    code_piece: string | null;
    quantite: number;
    unite: string | null;
    prix_unitaire_ht: number;
    taux_tva: number | null;
    total_ttc: number;
  }>;
  /**
   * Instantane de l'emetteur : identite legale et mentions obligatoires.
   *
   * L'accuse de reception est un document commercial envoye au client par courriel : il
   * doit porter l'identite legale de son emetteur au meme titre que la facture et le bon de
   * livraison (art. R123-237 C. com.). Il ne portait aucune mention.
   */
  issuer: LegalParty;
}): Promise<Buffer> {
  const clientName = params.companyName?.trim() || "Client";
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
      code: params.draftNumber,
      subtitle: `Commande ${params.draftNumber}`,
      status: params.statut ?? "PLANIFIEE",
      monogramName: clientName,
      generatedAt: formatDateFR(params.generatedAt.toISOString()),
      title: `Accusé de réception ${params.draftNumber}`,
      subject: "Accusé de réception de commande CERP",
      legalIdentity: issuerIdentityLine(params.issuer),
      legalMentions: issuerLegalMentions(params.issuer),
      creationDate: params.generatedAt,
    },
    (ctx) => {
      ctx.legalStrip([
        { label: "Commande", value: params.draftNumber },
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

export async function svcGenerateCommandeAr(params: {
  commande_id: number;
  user_id: number;
  user_role: string | null | undefined;
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
    const subject = subjectForCommande(data.header.numero);
    const bodyText = bodyTextForCommande({
      numero: data.header.numero,
      companyName: data.header.client_company_name,
    });

    const generatedAt = new Date();
    // An acknowledgement is fixed by the generated PDF. It carries the legal version in
    // force when that artifact is created, not the possibly much older order date.
    const issuer = await readIssuerParty({ at: generatedAt.toISOString().slice(0, 10) });

    const pdfBuffer = await buildCommandeArPdfBuffer({
      issuer,
      draftNumber: data.header.numero,
      companyName: data.header.client_company_name,
      dateCommande: data.header.date_commande,
      generatedAt,
      statut: data.header.statut,
      totalHt: data.header.total_ht,
      totalTtc: data.header.total_ttc,
      commentaire: data.header.commentaire,
      clientEmail: data.header.client_email,
      clientPhone: data.header.client_phone,
      billAddress: {
        name: data.header.bill_name,
        street: data.header.bill_street,
        house_number: data.header.bill_house_number,
        postal_code: data.header.bill_postal_code,
        city: data.header.bill_city,
        country: data.header.bill_country,
      },
      deliveryAddress: {
        name: data.header.deliv_name,
        street: data.header.deliv_street,
        house_number: data.header.deliv_house_number,
        postal_code: data.header.deliv_postal_code,
        city: data.header.deliv_city,
        country: data.header.deliv_country,
      },
      lines: data.lines,
    });

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const documentName = `AR_${data.header.numero}_${timestamp}.pdf`;
    const draft = await repoCreateCommandeArDraft({
      commande_id: params.commande_id,
      user_id: params.user_id,
      user_role: params.user_role,
      document_name: documentName,
      pdf_buffer: pdfBuffer,
      subject,
      body_text: bodyText,
      recipient_suggestions: recipientSuggestions,
    });

    emitEntityChanged({
      entityType: "commande_client",
      entityId: String(params.commande_id),
      action: "updated",
      module: "commandes",
      at: new Date().toISOString(),
      by: { id: params.user_id, name: `User #${params.user_id}` },
      invalidateKeys: ["commandes:list", `commandes:detail:${params.commande_id}`],
    });

    return {
      ar_id: draft.ar_id,
      commande_id: params.commande_id,
      document_id: draft.document_id,
      document_name: draft.document_name,
      subject: draft.subject,
      generated_at: draft.generated_at,
      generated_by: draft.generated_by,
      status: draft.status,
      sent_at: draft.sent_at,
      preview_path: draft.preview_path,
      recipient_suggestions: recipientSuggestions,
    };
  } finally {
    client.release();
  }
}

export async function svcSendCommandeAr(params: {
  commande_id: number;
  user_id: number;
  user_role: string | null | undefined;
  body: SendCommandeArBodyDTO;
}): Promise<CommandeArSendResult> {
  const claimResult = await repoClaimCommandeArSend({
    commande_id: params.commande_id,
    ar_id: params.body.ar_id,
    user_id: params.user_id,
    user_role: params.user_role,
  });
  if (claimResult.kind === "replay") {
    return {
      ar_id: claimResult.draft.ar_id,
      commande_id: params.commande_id,
      document_id: claimResult.draft.document_id,
      status: "AR_ENVOYE",
      sent_at: claimResult.draft.sent_at ?? new Date().toISOString(),
      recipient_emails: claimResult.draft.recipient_emails,
      email_provider_id: claimResult.draft.email_provider_id,
    };
  }

  const claim = claimResult;
  const draft = claim.draft;
  let claimOpen = true;
  try {
    const filePath = path.resolve(getDocumentStoragePath(), `${draft.document_id}.pdf`);
    const pdfBuffer = await fs.readFile(filePath);

    const baseText = draft.body_text?.trim() || `Veuillez trouver ci-joint l'accuse de reception de la commande.`;
    const customMessage = params.body.message?.trim() || null;
    const fullText = customMessage ? `${baseText}\n\n${customMessage}` : baseText;

    const emailResult = await sendTransactionalEmail({
      to: params.body.recipient_emails,
      subject: draft.subject,
      text: fullText,
      html: buildEmailHtml(baseText, customMessage),
      idempotencyKey: `commande-ar:${params.body.ar_id}`,
      attachments: [
        {
          filename: draft.document_name,
          content: pdfBuffer,
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
      claimOpen = false;
      await repoMarkCommandeArFailed({
        commande_id: params.commande_id,
        ar_id: params.body.ar_id,
        error_message: message,
        claim,
      });
      throw new HttpError(statusCode, "COMMANDE_AR_SEND_FAILED", message);
    }

    claimOpen = false;
    const finalized = await repoFinalizeCommandeArSend({
      claim,
      commande_id: params.commande_id,
      ar_id: params.body.ar_id,
      sent_by: params.user_id,
      recipient_emails: params.body.recipient_emails,
      recipient_contact_ids: params.body.recipient_contact_ids,
      email_provider_id: emailResult.id ?? null,
      commentaire: `AR envoyé à ${params.body.recipient_emails.join(", ")}`,
    });

    for (const notification of finalized.notifications) {
      emitAppNotificationCreated(notification.user_id, notification);
    }
    emitEntityChanged({
      entityType: "commande_client",
      entityId: String(params.commande_id),
      action: "status_changed",
      module: "commandes",
      at: new Date().toISOString(),
      by: { id: params.user_id, name: `User #${params.user_id}` },
      invalidateKeys: ["commandes:list", `commandes:detail:${params.commande_id}`],
    });

    return finalized.result;
  } catch (err) {
    if (claimOpen) await repoAbortCommandeArSendClaim(claim);
    throw err;
  }
}
