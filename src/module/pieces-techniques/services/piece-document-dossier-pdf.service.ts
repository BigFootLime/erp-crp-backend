// src/module/pieces-techniques/services/piece-document-dossier-pdf.service.ts
// Issue #227 — dossier documentaire contrôlé, rendu PDF côté serveur.
//
// Le rendu prend en entrée EXACTEMENT le payload que l'aperçu écran consomme
// (`PieceDocumentDossier`). Aucune requête, aucun recalcul : ce fichier ne sait que
// dessiner. C'est ce qui garantit qu'un dossier imprimé ne peut pas contredire l'écran.
import PDFDocument from "pdfkit";

import {
  DOCUMENT_SLOT_STATE_LABELS,
  type DocumentSlotState,
} from "../domain/document-policy";
import type { PieceDocumentDossier } from "./document-policy.service";

function formatDateTimeFR(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * WinAnsi ne connaît ni les espaces insécables fines ni les tirets cadratins que porte
 * la copie française : pdfkit les rendrait en losanges. On normalise avant de dessiner.
 */
function winAnsi(value: string): string {
  return value
    .replace(/[   ]/g, " ")
    .replace(/[—–]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...");
}

const STATE_MARK: Record<DocumentSlotState, string> = {
  PRESENT: "[OK]",
  MISSING: "[MANQUE]",
  NOT_REQUIRED: "[-]",
  FORBIDDEN: "[REFUSE]",
  OBSOLETE: "[OBSOLETE]",
  PREVIEW_UNAVAILABLE: "[OK]",
  SERVER_ERROR: "[ERREUR]",
};

async function renderToBuffer(render: (doc: PDFKit.PDFDocument) => void, creationDate: Date): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: 42,
    info: { Title: "Dossier documentaire piece technique", CreationDate: creationDate },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(c as Buffer));
  render(doc);
  doc.end();
  await new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", (err) => reject(err));
  });
  return Buffer.concat(chunks);
}

function keyValue(doc: PDFKit.PDFDocument, key: string, value: string): void {
  doc.font("Helvetica-Bold").fontSize(9).text(winAnsi(key), { continued: true });
  doc.font("Helvetica").fontSize(9).text(winAnsi(` ${value}`));
}

function heading(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(12).text(winAnsi(title));
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(9);
}

/**
 * Rend le dossier documentaire contrôlé.
 *
 * Le PDF dit TOUT, y compris ce qui manque : un dossier de contrôle qui n'imprime que
 * les documents présents laisse croire à une conformité qui n'existe pas.
 */
export async function renderPieceDocumentDossierPdf(args: {
  dossier: PieceDocumentDossier;
  generatedBy: string;
  generatedAt?: Date;
}): Promise<Buffer> {
  const d = args.dossier;
  const generatedAt = args.generatedAt ?? new Date(d.generated_at);

  return renderToBuffer((doc) => {
    doc.font("Helvetica-Bold").fontSize(16).text(winAnsi("Dossier documentaire — pièce technique"));
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9).fillColor("#555555");
    doc.text(
      winAnsi(
        `Document de contrôle généré par CERP le ${formatDateTimeFR(generatedAt.toISOString())} par ${args.generatedBy}.`
      )
    );
    doc.fillColor("#000000");

    heading(doc, "Pièce");
    keyValue(doc, "Code pièce :", d.piece.code_piece || "-");
    keyValue(doc, "Désignation :", d.piece.designation || "-");
    keyValue(
      doc,
      "Client :",
      d.piece.client_id ? `${d.piece.client_name ?? "-"} (${d.piece.client_id})` : "Pièce standard (aucun client)"
    );
    keyValue(doc, "Indice :", d.version.indice ? `${d.version.indice} — ${d.version.statut ?? "-"}` : "-");
    keyValue(doc, "Pièce critique :", d.piece.piece_critique ? "Oui" : "Non");
    if (d.piece.piece_critique && d.piece.piece_critique_motif) {
      keyValue(doc, "Motif de criticité :", d.piece.piece_critique_motif);
    }

    heading(doc, "Politique documentaire appliquée");
    keyValue(doc, "Politique :", `${d.policy.label} (${d.policy.value})`);
    keyValue(
      doc,
      "Origine :",
      d.policy.frozen
        ? `Exigences figées à la publication de l'indice le ${formatDateTimeFR(d.version.requirements_frozen_at)}`
        : "Exigences calculées en direct — l'indice n'est pas encore publié"
    );
    if (d.policy.diverged_from_client) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#8a5a00");
      doc.text(
        winAnsi(
          "Avertissement : la politique du client a changé depuis la publication de cet indice. " +
            "Cet indice conserve les exigences figées ; le changement s'appliquera au prochain indice."
        ),
        { width: 500 }
      );
      doc.fillColor("#000000").font("Helvetica").fontSize(9);
    }
    if (!d.policy_infrastructure_ready) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#8a5a00");
      doc.text(
        winAnsi(
          "Avertissement : le référentiel documentaire n'est pas installé sur cette base. " +
            "Aucune exigence n'a pu être évaluée — ce dossier ne prouve aucune conformité."
        ),
        { width: 500 }
      );
      doc.fillColor("#000000").font("Helvetica").fontSize(9);
    }
    if (d.not_required_reason) {
      keyValue(doc, "Motif :", d.not_required_reason.reason_label);
    }

    heading(doc, "Synthèse");
    keyValue(doc, "Documents requis :", String(d.summary.required_total));
    keyValue(doc, "Fournis :", String(d.summary.present_total));
    keyValue(doc, "Manquants :", String(d.summary.missing_total));
    keyValue(doc, "Obsolètes :", String(d.summary.obsolete_total));
    keyValue(doc, "Dossier complet :", d.summary.complete ? "Oui" : "Non");

    heading(doc, "Détail par type de document");
    if (d.slots.length === 0) {
      doc.text(winAnsi("Aucun type de document au référentiel."));
    }

    for (const slot of d.slots) {
      doc.moveDown(0.35);
      const mark = STATE_MARK[slot.state] ?? "[?]";
      doc.font("Helvetica-Bold").fontSize(10);
      doc.text(winAnsi(`${mark} ${slot.document_type_label}${slot.required ? " (requis)" : ""}`));
      doc.font("Helvetica").fontSize(9).fillColor("#444444");
      doc.text(winAnsi(`État : ${DOCUMENT_SLOT_STATE_LABELS[slot.state]} — ${slot.state_detail}`), { width: 500 });
      if (slot.reason_label) doc.text(winAnsi(`Pourquoi : ${slot.reason_label}`), { width: 500 });
      if (slot.document) {
        doc.text(
          winAnsi(
            `Fichier : ${slot.document.original_name} (${slot.document.mime_type ?? "type inconnu"}, déposé le ${formatDateTimeFR(slot.document.created_at)})`
          ),
          { width: 500 }
        );
      }
      doc.fillColor("#000000");
    }

    doc.moveDown(1);
    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#666666");
    doc.text(
      winAnsi(
        "Ce dossier reflète l'état enregistré dans CERP à la date de génération. " +
          "Il est produit à partir des mêmes données que l'aperçu écran."
      ),
      { width: 500 }
    );
    doc.fillColor("#000000");
  }, generatedAt);
}
