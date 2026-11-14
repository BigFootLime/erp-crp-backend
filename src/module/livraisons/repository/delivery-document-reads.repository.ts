import fs from "node:fs/promises"
import path from "node:path"

import pool from "../../../config/database"
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage"

/**
 * Owns read-only lookup of a delivery attachment's metadata, linkage and
 * durable storage location. Delivery mutations remain in the delivery facade.
 */
async function ensureDocsDir(): Promise<string> {
  const baseDir = ensureDocumentStoragePath("livraisons")
  await fs.mkdir(baseDir, { recursive: true })
  return baseDir
}

export async function repoGetDocumentName(documentId: string): Promise<string | null> {
  const res = await pool.query<{ document_name: string }>(`SELECT document_name FROM documents_clients WHERE id = $1`, [documentId])
  const name = res.rows[0]?.document_name
  return typeof name === "string" && name.trim() ? name.trim() : null
}

export async function repoFindDocumentFilePath(documentId: string): Promise<string | null> {
  const baseDir = await ensureDocsDir()
  const pdfCandidate = path.join(baseDir, `${documentId}.pdf`)
  try {
    await fs.stat(pdfCandidate)
    return pdfCandidate
  } catch {
    // continue
  }

  const entries = await fs.readdir(baseDir).catch(() => [])
  const match = entries.find((e) => e.startsWith(documentId))
  if (!match) return null
  const candidate = path.join(baseDir, match)
  try {
    await fs.stat(candidate)
    return candidate
  } catch {
    return null
  }
}

export async function repoIsLivraisonDocumentLinked(bonLivraisonId: string, documentId: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM bon_livraison_documents WHERE bon_livraison_id = $1::uuid AND document_id = $2::uuid LIMIT 1`,
    [bonLivraisonId, documentId]
  )
  return (res.rowCount ?? 0) > 0
}
