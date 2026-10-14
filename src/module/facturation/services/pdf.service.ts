import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pool from "../../../config/database";
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";
import { repoGetAvoir } from "../repository/avoirs.repository";
import { repoGetFacture } from "../repository/factures.repository";
import { readFinanceDraftInput } from "./finance-draft-input";

import { readIssuerParty } from "../../../shared/documents/issuer-identity.repository";

import { renderFinanceDocument, type FinanceParty } from "./finance-document-render";

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

async function ensureDocsDir(): Promise<string> {
  const uploadDir = ensureDocumentStoragePath();
  await fs.mkdir(uploadDir, { recursive: true });
  return uploadDir;
}

/**
 * Identite de l'emetteur, mentions legales comprises.
 *
 * L'ancienne version lisait `to_jsonb(factureur)` et filtrait sur une liste blanche
 * comprenant `siret`, `siren`, `rcs`, `vat_number` et `capital_social`. **Aucune de ces
 * colonnes n'existe** dans `factureur` : le filtre ne retenait donc jamais la moindre
 * mention legale, et la table etait de surcroit vide sur les deux bases. Le bloc
 * « Emetteur » sortait vide et aucune mention obligatoire n'etait imprimee.
 *
 * La lecture passe desormais par `readIssuerParty()`, qui joint la table versionnee des
 * mentions et resout celles **en vigueur a la date d'emission** du document.
 */
async function getIssuerParty(issueDate: string | null): Promise<FinanceParty> {
  return readIssuerParty({ at: issueDate }) as Promise<FinanceParty>;
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

  const readClient = await pool.connect();
  let draftInput: Omit<Parameters<typeof renderFinanceDocument>[0], "issuer">;
  try {
    await readClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    draftInput = await readFinanceDraftInput(readClient, "FACTURE", factureId);
    await readClient.query("COMMIT");
  } catch (error) {
    await readClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { readClient.release(); }
  const pdf = await renderFinanceDocument({...draftInput, issuer: await getIssuerParty(draftInput.issueDate)});
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

  const readClient = await pool.connect();
  let draftInput: Omit<Parameters<typeof renderFinanceDocument>[0], "issuer">;
  try {
    await readClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    draftInput = await readFinanceDraftInput(readClient, "AVOIR", avoirId);
    await readClient.query("COMMIT");
  } catch (error) {
    await readClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { readClient.release(); }
  const pdf = await renderFinanceDocument({...draftInput, issuer: await getIssuerParty(draftInput.issueDate)});
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
