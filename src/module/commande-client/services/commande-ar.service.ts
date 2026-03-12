import PDFDocument from "pdfkit";
import fs from "node:fs/promises";
import path from "node:path";

import { HttpError } from "../../../utils/httpError";
import { emitAppNotificationCreated, emitEntityChanged } from "../../../shared/realtime/realtime.service";
import { sendTransactionalEmail, type ResendSendResult } from "../../../shared/email/resend.service";
import type {
  CommandeArDraft,
  CommandeArRecipientSuggestion,
  CommandeArSendResult,
} from "../types/commande-ar.types";
import type { SendCommandeArBodyDTO } from "../validators/commande-ar.validators";
import {
  buildCommandeArRecipientSuggestions,
  repoCreateCommandeArDraft,
  repoFinalizeCommandeArSend,
  repoGetCommandeArDraft,
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

async function buildPdfBuffer(params: {
  draftNumber: string;
  companyName: string | null;
  dateCommande: string;
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
}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("Accuse de reception", { align: "left" });
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor("#475569").text(`Commande ${params.draftNumber}`);
    doc.text(`Date commande: ${formatDateFR(params.dateCommande)}`);
    doc.text(`Statut: ${params.statut ?? "PLANIFIEE"}`);
    doc.fillColor("black");
    doc.moveDown();

    doc.fontSize(13).text("Client");
    doc.fontSize(10);
    doc.text(params.companyName ?? "-");
    doc.text(`Email: ${params.clientEmail ?? "-"}`);
    doc.text(`Telephone: ${params.clientPhone ?? "-"}`);
    doc.moveDown();

    doc.fontSize(13).text("Adresse de facturation");
    doc.fontSize(10);
    for (const line of addressLines(params.billAddress)) doc.text(line);
    doc.moveDown(0.5);
    doc.fontSize(13).text("Adresse de livraison");
    doc.fontSize(10);
    for (const line of addressLines(params.deliveryAddress)) doc.text(line);
    doc.moveDown();

    doc.fontSize(13).text("Lignes");
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor("#475569");
    doc.text("Designation", 40, doc.y, { width: 230 });
    doc.text("Qte", 275, doc.y, { width: 40, align: "right" });
    doc.text("PU HT", 320, doc.y, { width: 80, align: "right" });
    doc.text("TVA", 405, doc.y, { width: 50, align: "right" });
    doc.text("Total TTC", 460, doc.y, { width: 95, align: "right" });
    doc.moveDown(0.4);
    doc.fillColor("black");
    doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor("#cbd5e1").stroke();
    doc.moveDown(0.4);

    for (const line of params.lines) {
      const startY = doc.y;
      doc.fontSize(10).fillColor("black");
      doc.text(line.designation, 40, startY, { width: 230 });
      if (line.code_piece) {
        doc.fontSize(8).fillColor("#64748b").text(line.code_piece, 40, doc.y, { width: 230 });
      }
      doc.fontSize(10).fillColor("black");
      doc.text(String(line.quantite), 275, startY, { width: 40, align: "right" });
      doc.text(formatCurrencyEUR(line.prix_unitaire_ht), 320, startY, { width: 80, align: "right" });
      doc.text(`${line.taux_tva ?? 0}%`, 405, startY, { width: 50, align: "right" });
      doc.text(formatCurrencyEUR(line.total_ttc), 460, startY, { width: 95, align: "right" });
      doc.moveDown(0.8);
    }

    doc.moveDown();
    doc.fontSize(11).text(`Total HT: ${formatCurrencyEUR(params.totalHt)}`, { align: "right" });
    doc.text(`Total TTC: ${formatCurrencyEUR(params.totalTtc)}`, { align: "right" });
    if (params.commentaire?.trim()) {
      doc.moveDown();
      doc.fontSize(11).text("Notes");
      doc.fontSize(10).text(params.commentaire.trim());
    }

    doc.end();
  });
}

export async function svcGenerateCommandeAr(params: {
  commande_id: number;
  user_id: number;
}): Promise<CommandeArDraft> {
  const client = await pool.connect();
  try {
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

    const pdfBuffer = await buildPdfBuffer({
      draftNumber: data.header.numero,
      companyName: data.header.client_company_name,
      dateCommande: data.header.date_commande,
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
  body: SendCommandeArBodyDTO;
}): Promise<CommandeArSendResult> {
  const draft = await repoGetCommandeArDraft({ commande_id: params.commande_id, ar_id: params.body.ar_id });
  if (!draft) {
    throw new HttpError(404, "COMMANDE_AR_NOT_FOUND", "Accusé de réception introuvable");
  }

  const filePath = path.resolve("uploads/docs", `${draft.document_id}.pdf`);
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
    await repoMarkCommandeArFailed({
      commande_id: params.commande_id,
      ar_id: params.body.ar_id,
      error_message: message,
    });
    throw new HttpError(statusCode, "COMMANDE_AR_SEND_FAILED", message);
  }

  const finalized = await repoFinalizeCommandeArSend({
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
}
