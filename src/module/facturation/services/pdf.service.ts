import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pool from "../../../config/database";
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";
import { repoGetAvoir } from "../repository/avoirs.repository";
import { repoGetFacture } from "../repository/factures.repository";

import { renderFinanceDocument, type FinanceDocumentLine, type FinanceParty } from "./finance-document-render";

/**
 * Facture et avoir a l'etat de **brouillon**.
 *
 * Le rendu vit dans `finance-document-render.ts`, partage avec les exemplaires legaux
 * immuables : trois chemins dessinaient auparavant leur propre mise en page, dont deux pour la
 * seule facture. Un client pouvait recevoir un brouillon et une facture d'aspect completement
 * different pour le meme montant.
 *
 * Ces deux fonctions **refusent de s'executer sur un document emis** : l'exemplaire legal est
 * ecrit une seule fois, par le workflow, et ne se regenere pas.
 */

/** Montant du referentiel (nombre) vers la chaine a deux decimales attendue par le rendu. */
function amount(value: number | null | undefined): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return n.toFixed(2);
}

async function ensureDocsDir(): Promise<string> {
  const uploadDir = ensureDocumentStoragePath();
  await fs.mkdir(uploadDir, { recursive: true });
  return uploadDir;
}

/**
 * Identite de l'emetteur, lue en base.
 *
 * `to_jsonb` remonte la ligne entiere et on ne retient qu'une **liste blanche** de champs
 * d'identite fiscale : la table `factureur` est historique et sa forme exacte n'appartient pas
 * a ce module. Un champ absent reste absent — aucune mention n'est inventee.
 */
const ISSUER_LEGAL_FIELDS = [
  "company_name",
  "biller_name",
  "name",
  "raison_sociale",
  "address_line_1",
  "address_line_2",
  "address",
  "adresse",
  "adresse_complement",
  "postal_code",
  "code_postal",
  "city",
  "ville",
  "country",
  "pays",
  "siret",
  "siren",
  "rcs",
  "vat_number",
  "numero_tva",
  "tva_intracommunautaire",
  "capital_social",
] as const;

async function getIssuerParty(): Promise<FinanceParty> {
  const res = await pool.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(f) AS row FROM factureur f ORDER BY f.biller_id ASC LIMIT 1`
  );
  const row = res.rows[0]?.row;
  if (!row || typeof row !== "object") return {};

  const party: FinanceParty = {};
  for (const key of ISSUER_LEGAL_FIELDS) {
    if (row[key] !== undefined && row[key] !== null) party[key] = row[key];
  }
  return party;
}

/**
 * Identite du client telle que connue du referentiel de facturation.
 *
 * ⚠️ `client_id` est un identifiant technique : il n'entre pas dans la partie. L'ancienne
 * version l'imprimait sous la raison sociale, sur un document adresse au client.
 */
function clientParty(client: { company_name?: string | null } | null | undefined): FinanceParty {
  const name = typeof client?.company_name === "string" ? client.company_name.trim() : "";
  return name ? { company_name: name } : {};
}

function draftLines(
  lignes: Array<{
    designation: string;
    code_piece: string | null;
    quantite: number;
    unite: string | null;
    prix_unitaire_ht: number;
    remise_ligne: number;
    taux_tva: number;
    total_ht: number;
    total_ttc: number;
  }>
): FinanceDocumentLine[] {
  return lignes.map((line) => ({
    designation: line.designation,
    codePiece: line.code_piece,
    quantity: String(line.quantite ?? 0),
    unit: line.unite,
    unitPriceExTax: amount(line.prix_unitaire_ht),
    discountPercent: amount(line.remise_ligne),
    taxRatePercent: amount(line.taux_tva),
    totalExTax: amount(line.total_ht),
    // Le referentiel du brouillon ne stocke pas la taxe par ligne : elle se deduit des deux
    // totaux deja calcules, sans jamais reappliquer un taux nous-memes.
    taxAmount: amount((line.total_ttc ?? 0) - (line.total_ht ?? 0)),
    totalInclTax: amount(line.total_ttc),
  }));
}

export async function svcGenerateFacturePdf(factureId: number): Promise<{ document_id: string }> {
  const detail = await repoGetFacture(factureId, "client,lignes");
  if (!detail) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture not found");
  if (["ISSUED", "PARTIALLY_PAID", "PAID"].includes(detail.facture.statut)) {
    throw new HttpError(
      409,
      "FACTURE_DOCUMENT_IMMUTABLE",
      "Le PDF légal émis est immuable et ne peut pas être régénéré."
    );
  }

  const docsDir = await ensureDocsDir();
  const documentId = crypto.randomUUID();
  const fileName = `Facture_${detail.facture.numero}.pdf`;
  const filePath = path.join(docsDir, `${documentId}.pdf`);

  const f = detail.facture;
  const pdf = await renderFinanceDocument({
    kind: "FACTURE",
    number: f.numero,
    draft: true,
    issueDate: f.date_emission,
    currency: "EUR",
    issuer: await getIssuerParty(),
    client: clientParty(f.client),
    lines: draftLines(detail.lignes),
    totals: {
      subtotalExTax: amount(f.total_ht),
      globalDiscountPercent: amount(f.remise_globale),
      globalDiscountAmount: "0.00",
      totalExTax: amount(f.total_ht),
      totalTax: amount((f.total_ttc ?? 0) - (f.total_ht ?? 0)),
      totalInclTax: amount(f.total_ttc),
    },
    dueDates: f.date_echeance ? [{ dueDate: f.date_echeance, label: "Échéance", amount: amount(f.total_ttc) }] : [],
    customerText: f.commentaires,
    draftReference: f.numero,
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, pdf);

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      `INSERT INTO documents_clients (id, document_name, type) VALUES ($1, $2, $3)` ,
      [documentId, fileName, "PDF"]
    );
    await db.query(
      `INSERT INTO facture_documents (facture_id, document_id, type) VALUES ($1, $2, $3)` ,
      [factureId, documentId, "PDF"]
    );
    await db.query(`UPDATE facture SET updated_at = now() WHERE id = $1`, [factureId]);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    await fs.unlink(filePath).catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }

  return { document_id: documentId };
}

export async function svcGenerateAvoirPdf(avoirId: number): Promise<{ document_id: string }> {
  const detail = await repoGetAvoir(avoirId, "client,lignes,facture");
  if (!detail) throw new HttpError(404, "AVOIR_NOT_FOUND", "Avoir not found");
  if (detail.avoir.statut === "ISSUED") {
    throw new HttpError(
      409,
      "AVOIR_DOCUMENT_IMMUTABLE",
      "Le PDF légal émis est immuable et ne peut pas être régénéré."
    );
  }

  const docsDir = await ensureDocsDir();
  const documentId = crypto.randomUUID();
  const fileName = `Avoir_${detail.avoir.numero}.pdf`;
  const filePath = path.join(docsDir, `${documentId}.pdf`);

  const a = detail.avoir;
  const pdf = await renderFinanceDocument({
    kind: "AVOIR",
    number: a.numero,
    draft: true,
    issueDate: a.date_emission,
    currency: "EUR",
    issuer: await getIssuerParty(),
    client: clientParty(a.client),
    lines: draftLines(detail.lignes),
    totals: {
      subtotalExTax: amount(a.total_ht),
      globalDiscountPercent: "0.00",
      globalDiscountAmount: "0.00",
      totalExTax: amount(a.total_ht),
      totalTax: amount((a.total_ttc ?? 0) - (a.total_ht ?? 0)),
      totalInclTax: amount(a.total_ttc),
    },
    dueDates: [],
    correctedInvoice: a.facture?.numero ?? null,
    reason: a.motif,
    draftReference: a.numero,
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, pdf);

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      `INSERT INTO documents_clients (id, document_name, type) VALUES ($1, $2, $3)` ,
      [documentId, fileName, "PDF"]
    );
    await db.query(
      `INSERT INTO avoir_documents (avoir_id, document_id, type) VALUES ($1, $2, $3)` ,
      [avoirId, documentId, "PDF"]
    );
    await db.query(`UPDATE avoir SET updated_at = now() WHERE id = $1`, [avoirId]);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    await fs.unlink(filePath).catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }

  return { document_id: documentId };
}

export async function svcGetLatestFacturePdfDocumentId(factureId: number): Promise<string | null> {
  const res = await pool.query<{ document_id: string }>(
    `
    SELECT fd.document_id::text AS document_id
    FROM facture_documents fd
    WHERE fd.facture_id = $1
    ORDER BY fd.id DESC
    LIMIT 1
    `,
    [factureId]
  );
  return res.rows[0]?.document_id ?? null;
}

export async function svcGetLatestAvoirPdfDocumentId(avoirId: number): Promise<string | null> {
  const res = await pool.query<{ document_id: string }>(
    `
    SELECT ad.document_id::text AS document_id
    FROM avoir_documents ad
    WHERE ad.avoir_id = $1
    ORDER BY ad.id DESC
    LIMIT 1
    `,
    [avoirId]
  );
  return res.rows[0]?.document_id ?? null;
}

export async function svcGetPdfFilePath(documentId: string): Promise<string> {
  const docsDir = await ensureDocsDir();
  return path.join(docsDir, `${documentId}.pdf`);
}

export async function svcGetDocumentName(documentId: string): Promise<string | null> {
  const res = await pool.query<{ document_name: string }>(
    `SELECT document_name FROM documents_clients WHERE id = $1`,
    [documentId]
  );
  const name = res.rows[0]?.document_name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
