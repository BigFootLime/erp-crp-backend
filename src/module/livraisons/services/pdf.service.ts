import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"

import pool from "../../../config/database"
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage"
import { HttpError } from "../../../utils/httpError"
import { readIssuerParty } from "../../../shared/documents/issuer-identity.repository"
import { pickMention } from "../../../shared/pdf/legal-mentions"
import { repoGetLivraisonDetail, repoGetDocumentName } from "../repository/livraisons.repository"

import { renderBonLivraisonDocument } from "./bon-livraison-document"

/**
 * Generation simple du bon de livraison (`POST /livraisons/:id/pdf`).
 *
 * Le rendu vit dans `bon-livraison-document.ts`, partage avec le pack fige : ce service ne
 * s'occupe plus que du versionnement, du stockage, de l'empreinte et du journal. Les deux
 * chemins dessinaient auparavant leur propre mise en page, et l'ancienne imprimait
 * l'identifiant technique du client sur un document envoye au client.
 */

async function ensureDocsDir(): Promise<string> {
  const uploadDir = ensureDocumentStoragePath("livraisons")
  await fs.mkdir(uploadDir, { recursive: true })
  return uploadDir
}

// L'emetteur n'est plus reduit a sa raison sociale : `readIssuerParty` remonte aussi son
// identite legale et ses mentions obligatoires, que le bon de livraison doit porter.

export async function svcGetLatestLivraisonPdfDocument(id: string): Promise<{ document_id: string; version: number } | null> {
  const res = await pool.query<{ document_id: string; version: number }>(
    `
    SELECT d.document_id::text AS document_id, d.version
    FROM bon_livraison_documents d
    WHERE d.bon_livraison_id = $1::uuid AND d.type = 'PDF'
    ORDER BY d.version DESC, d.id DESC
    LIMIT 1
    `,
    [id]
  )
  const row = res.rows[0]
  return row ? { document_id: row.document_id, version: row.version } : null
}

export async function svcGetPdfFilePath(documentId: string): Promise<string> {
  const docsDir = await ensureDocsDir()
  return path.join(docsDir, `${documentId}.pdf`)
}

export async function svcGenerateLivraisonPdf(bonLivraisonId: string, userId: number): Promise<{ document_id: string; version: number }> {
  const detail = await repoGetLivraisonDetail(bonLivraisonId)
  if (!detail) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")

  const existing = await svcGetLatestLivraisonPdfDocument(bonLivraisonId)
  const version = (existing?.version ?? 0) + 1

  const docsDir = await ensureDocsDir()
  const documentId = crypto.randomUUID()
  const fileName = `Bon_livraison_${detail.bon_livraison.numero}.pdf`
  const filePath = path.join(docsDir, `${documentId}.pdf`)

  const issuer = await readIssuerParty({
    at: detail.bon_livraison.date_expedition ?? detail.bon_livraison.date_creation,
  })
  const pdfBytes = await renderBonLivraisonDocument({
    header: detail.bon_livraison,
    lignes: detail.lignes,
    version,
    company: pickMention(issuer, "company_name"),
    issuer,
  })
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, pdfBytes)

  const checksumSha256 = crypto.createHash("sha256").update(pdfBytes).digest("hex")

  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    await db.query(`INSERT INTO documents_clients (id, document_name, type) VALUES ($1, $2, $3)`, [documentId, fileName, "PDF"])
    await db.query(
      `
        INSERT INTO bon_livraison_documents (
          bon_livraison_id,
          document_id,
          type,
          version,
          uploaded_by,
          checksum_sha256,
          file_size_bytes,
          mime_type
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'application/pdf')
      `,
      [bonLivraisonId, documentId, "PDF", version, userId, checksumSha256, pdfBytes.byteLength]
    )
    await db.query(
      `INSERT INTO bon_livraison_event_log (bon_livraison_id, event_type, old_values, new_values, user_id)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
      [
        bonLivraisonId,
        "PDF_GENERATED",
        null,
        JSON.stringify({ document_id: documentId, version, checksum_sha256: checksumSha256 }),
        userId,
      ]
    )
    await db.query(`UPDATE bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [bonLivraisonId, userId])
    await db.query("COMMIT")
  } catch (err) {
    await db.query("ROLLBACK")
    await fs.unlink(filePath).catch(() => undefined)
    throw err
  } finally {
    db.release()
  }

  return { document_id: documentId, version }
}

export async function svcGetDocumentName(documentId: string) {
  return repoGetDocumentName(documentId)
}
