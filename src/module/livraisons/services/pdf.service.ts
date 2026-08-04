import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { PoolClient } from "pg"

import pool from "../../../config/database"
import { readIssuerParty } from "../../../shared/documents/issuer-identity.repository"
import { pickMention } from "../../../shared/pdf/legal-mentions"
import {
  ensureDocumentStoragePath,
  getDocumentStoragePath,
} from "../../../utils/cerpStorage"
import { HttpError } from "../../../utils/httpError"
import logger from "../../../utils/logger"
import { repoGetLivraisonDetail, repoGetDocumentName } from "../repository/livraisons.repository"
import type {
  BonLivraisonStatut,
  LivraisonPdfAvailability,
  LivraisonPdfGenerationResult,
} from "../types/livraisons.types"

import { renderBonLivraisonDocument } from "./bon-livraison-document"

type Queryable = Pick<PoolClient, "query">

type PdfDocumentRow = {
  bon_livraison_id: string
  document_id: string | null
  version: number | null
  generated_at: string | null
  file_size_bytes: number | null
  checksum_sha256: string | null
}

type LivraisonPdfReadResult =
  | (Extract<LivraisonPdfAvailability, { available: false }> & { bytes: null })
  | (Extract<LivraisonPdfAvailability, { available: true }> & { bytes: Buffer })

const generatedPdfPredicate = `
  (
    document.type = 'GENERATED_SIMPLE_BL_PDF'
    OR (
      document.type = 'PDF'
      AND EXISTS (
        SELECT 1
        FROM public.bon_livraison_event_log event
        WHERE event.bon_livraison_id = document.bon_livraison_id
          AND event.event_type = 'PDF_GENERATED'
          AND event.new_values ->> 'document_id' = document.document_id::text
      )
    )
  )
`

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 8 || normalized.length > 200) {
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header is required (8 to 200 characters)."
    )
  }
  return normalized
}

function idempotencyKeyHash(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex")
}

async function queryPdfDocument(
  bonLivraisonId: string,
  version?: number,
  queryable: Queryable = pool
): Promise<PdfDocumentRow | null> {
  const result = await queryable.query<PdfDocumentRow>(
    `
      SELECT
        delivery.id::text AS bon_livraison_id,
        latest.document_id,
        latest.version,
        latest.generated_at,
        latest.file_size_bytes,
        latest.checksum_sha256
      FROM public.bon_livraison delivery
      LEFT JOIN LATERAL (
        SELECT
          document.document_id::text AS document_id,
          document.version::int AS version,
          document.created_at::text AS generated_at,
          document.file_size_bytes::float8 AS file_size_bytes,
          document.checksum_sha256
        FROM public.bon_livraison_documents document
        WHERE document.bon_livraison_id = delivery.id
          AND ${generatedPdfPredicate}
          AND ($2::int IS NULL OR document.version = $2::int)
        ORDER BY document.version DESC, document.created_at DESC, document.id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE delivery.id = $1::uuid
    `,
    [bonLivraisonId, version ?? null]
  )
  return result.rows[0] ?? null
}

async function assertStoredPdf(
  documentId: string,
  expectedSize: number | null,
  expectedChecksum: string | null
): Promise<Buffer> {
  const filePath = svcGetPdfFilePath(documentId)
  try {
    const bytes = await fs.readFile(filePath)
    if (
      bytes.byteLength < 5 ||
      bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
    ) {
      throw new HttpError(
        500,
        "LIVRAISON_PDF_INVALID",
        "Le PDF archive est invalide. Une regeneration explicite est requise."
      )
    }
    if (expectedSize !== null && expectedSize > 0 && bytes.byteLength !== expectedSize) {
      throw new HttpError(
        500,
        "LIVRAISON_PDF_INTEGRITY_ERROR",
        "Le PDF archive ne correspond plus a son empreinte de stockage."
      )
    }
    if (expectedChecksum !== null) {
      const normalizedChecksum = expectedChecksum.trim().toLowerCase()
      const actualChecksum = crypto.createHash("sha256").update(bytes).digest("hex")
      if (!/^[a-f0-9]{64}$/.test(normalizedChecksum) || actualChecksum !== normalizedChecksum) {
        throw new HttpError(
          500,
          "LIVRAISON_PDF_INTEGRITY_ERROR",
          "Le PDF archive ne correspond plus a son empreinte SHA-256."
        )
      }
    }
    return bytes
  } catch (error) {
    if (error instanceof HttpError) throw error
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : ""
    if (code === "ENOENT") {
      throw new HttpError(
        410,
        "LIVRAISON_PDF_FILE_MISSING",
        "Le PDF archive est reference mais son fichier est indisponible. Une regeneration explicite est requise."
      )
    }
    throw error
  }
}

async function readLivraisonPdf(
  bonLivraisonId: string,
  version?: number
): Promise<LivraisonPdfReadResult> {
  const row = await queryPdfDocument(bonLivraisonId, version)
  if (!row) {
    throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
  }
  if (!row.document_id || !row.version || !row.generated_at) {
    if (version !== undefined) {
      throw new HttpError(
        404,
        "LIVRAISON_PDF_VERSION_NOT_FOUND",
        `La version ${version} du PDF n'existe pas.`
      )
    }
    return {
      available: false,
      status: "NOT_GENERATED",
      document_id: null,
      version: null,
      generated_at: null,
      bytes: null,
    }
  }

  const bytes = await assertStoredPdf(
    row.document_id,
    row.file_size_bytes,
    row.checksum_sha256
  )
  return {
    available: true,
    status: "AVAILABLE",
    document_id: row.document_id,
    version: row.version,
    generated_at: row.generated_at,
    bytes,
  }
}

export async function svcGetLivraisonPdfAvailability(
  bonLivraisonId: string,
  version?: number
): Promise<LivraisonPdfAvailability> {
  const result = await readLivraisonPdf(bonLivraisonId, version)
  if (!result.available) {
    return {
      available: false,
      status: result.status,
      document_id: null,
      version: null,
      generated_at: null,
    }
  }
  return {
    available: true,
    status: result.status,
    document_id: result.document_id,
    version: result.version,
    generated_at: result.generated_at,
  }
}

export async function svcReadLivraisonPdf(
  bonLivraisonId: string,
  version?: number
): Promise<LivraisonPdfReadResult> {
  return readLivraisonPdf(bonLivraisonId, version)
}

export function svcGetPdfFilePath(documentId: string): string {
  return path.join(getDocumentStoragePath("livraisons"), `${documentId}.pdf`)
}

async function findIdempotentReplay(
  db: Queryable,
  bonLivraisonId: string,
  userId: number,
  keyHash: string
): Promise<PdfDocumentRow | null> {
  const result = await db.query<PdfDocumentRow>(
    `
      SELECT
        event.bon_livraison_id::text AS bon_livraison_id,
        document.document_id::text AS document_id,
        document.version::int AS version,
        document.created_at::text AS generated_at,
        document.file_size_bytes::float8 AS file_size_bytes,
        document.checksum_sha256
      FROM public.bon_livraison_event_log event
      JOIN public.bon_livraison_documents document
        ON document.bon_livraison_id = event.bon_livraison_id
       AND document.document_id::text = event.new_values ->> 'document_id'
      WHERE event.bon_livraison_id = $1::uuid
        AND event.user_id = $2
        AND event.event_type = 'PDF_GENERATED'
        AND event.new_values ->> 'idempotency_key_hash' = $3
      ORDER BY event.id DESC
      LIMIT 1
    `,
    [bonLivraisonId, userId, keyHash]
  )
  return result.rows[0] ?? null
}

async function reconcilePdfCommit(args: {
  bonLivraisonId: string
  userId: number
  keyHash: string
}): Promise<PdfDocumentRow | null> {
  const reconciliationDb = await pool.connect()
  let discardConnection = false
  try {
    const delivery = await reconciliationDb.query<{ id: string }>(
      `SELECT id::text AS id FROM public.bon_livraison WHERE id = $1::uuid FOR UPDATE`,
      [args.bonLivraisonId]
    )
    if (!delivery.rows[0]) {
      throw new Error("Delivery disappeared while reconciling an uncertain PDF commit")
    }
    return findIdempotentReplay(
      reconciliationDb,
      args.bonLivraisonId,
      args.userId,
      args.keyHash
    )
  } catch (error) {
    discardConnection = true
    throw error
  } finally {
    reconciliationDb.release(discardConnection)
  }
}

function uncertainPdfCommitError(args: {
  result: LivraisonPdfGenerationResult
  commitError: unknown
  reconciliationError?: unknown
}): HttpError {
  logger.error("livraison_pdf_commit_uncertain", {
    document_id: args.result.document_id,
    version: args.result.version,
    commit_error: args.commitError instanceof Error ? args.commitError.message : String(args.commitError),
    reconciliation_error:
      args.reconciliationError instanceof Error
        ? args.reconciliationError.message
        : args.reconciliationError === undefined
          ? null
          : String(args.reconciliationError),
  })
  return new HttpError(
    503,
    "LIVRAISON_PDF_COMMIT_UNCERTAIN",
    "L'etat de la generation PDF doit etre reconcilie. Rejouez la meme Idempotency-Key et suivez le runbook sans supprimer le fichier archive.",
    {
      document_id: args.result.document_id,
      version: args.result.version,
      runbook: "docs/livraison-document-cerp-213.md#commit-postgresql-incertain",
    }
  )
}

async function nextPdfVersion(db: Queryable, bonLivraisonId: string): Promise<number> {
  const result = await db.query<{ version: number }>(
    `
      SELECT COALESCE(MAX(document.version), 0)::int + 1 AS version
      FROM public.bon_livraison_documents document
      WHERE document.bon_livraison_id = $1::uuid
        AND ${generatedPdfPredicate}
    `,
    [bonLivraisonId]
  )
  const version = result.rows[0]?.version
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("Failed to compute livraison PDF version")
  }
  return version
}

/**
 * Generate one archived BL version.
 *
 * The delivery row lock serializes concurrent generation requests. Replaying the same
 * actor/key returns the original result, while a new key intentionally creates a new version.
 */
export async function svcGenerateLivraisonPdf(
  bonLivraisonId: string,
  userId: number,
  idempotencyKeyRaw: string
): Promise<LivraisonPdfGenerationResult> {
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyRaw)
  const keyHash = idempotencyKeyHash(idempotencyKey)
  const db = await pool.connect()
  let filePath: string | null = null
  let temporaryPath: string | null = null
  let committed = false
  let commitAttempted = false
  let primaryConnectionReleased = false
  let cleanupAllowed = true
  let pendingResult: LivraisonPdfGenerationResult | null = null

  try {
    await db.query("BEGIN")
    const delivery = await db.query<{ id: string; statut: BonLivraisonStatut }>(
      `SELECT id::text AS id, statut FROM public.bon_livraison WHERE id = $1::uuid FOR UPDATE`,
      [bonLivraisonId]
    )
    const lockedDelivery = delivery.rows[0]
    if (!lockedDelivery) {
      throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
    }
    if (lockedDelivery.statut === "CANCELLED") {
      throw new HttpError(
        409,
        "LIVRAISON_CANCELLED_PDF_FORBIDDEN",
        "Un bon de livraison annulé ne peut plus générer de nouveau PDF."
      )
    }

    const replay = await findIdempotentReplay(db, bonLivraisonId, userId, keyHash)
    if (replay?.document_id && replay.version) {
      await assertStoredPdf(
        replay.document_id,
        replay.file_size_bytes,
        replay.checksum_sha256
      )
      pendingResult = {
        document_id: replay.document_id,
        version: replay.version,
        idempotent_replay: true,
      }
      commitAttempted = true
      await db.query("COMMIT")
      committed = true
      return pendingResult
    }

    const detail = await repoGetLivraisonDetail(bonLivraisonId)
    if (!detail) {
      throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
    }
    const version = await nextPdfVersion(db, bonLivraisonId)
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

    const docsDir = ensureDocumentStoragePath("livraisons")
    const documentId = crypto.randomUUID()
    const fileName = `Bon_livraison_${detail.bon_livraison.numero}.pdf`
    filePath = path.join(docsDir, `${documentId}.pdf`)
    temporaryPath = path.join(docsDir, `.${documentId}.pdf.tmp`)
    await fs.writeFile(temporaryPath, pdfBytes, { flag: "wx" })
    await fs.rename(temporaryPath, filePath)
    temporaryPath = null

    const checksumSha256 = crypto.createHash("sha256").update(pdfBytes).digest("hex")
    await db.query(
      `INSERT INTO public.documents_clients (id, document_name, type) VALUES ($1, $2, 'PDF')`,
      [documentId, fileName]
    )
    await db.query(
      `
        INSERT INTO public.bon_livraison_documents (
          bon_livraison_id,
          document_id,
          type,
          version,
          uploaded_by,
          checksum_sha256,
          file_size_bytes,
          mime_type
        )
        VALUES ($1::uuid, $2::uuid, 'GENERATED_SIMPLE_BL_PDF', $3, $4, $5, $6, 'application/pdf')
      `,
      [bonLivraisonId, documentId, version, userId, checksumSha256, pdfBytes.byteLength]
    )
    await db.query(
      `
        INSERT INTO public.bon_livraison_event_log (
          bon_livraison_id,
          event_type,
          old_values,
          new_values,
          user_id
        )
        VALUES ($1::uuid, 'PDF_GENERATED', NULL, $2::jsonb, $3)
      `,
      [
        bonLivraisonId,
        JSON.stringify({
          document_id: documentId,
          version,
          checksum_sha256: checksumSha256,
          idempotency_key_hash: keyHash,
        }),
        userId,
      ]
    )
    await db.query(
      `UPDATE public.bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`,
      [bonLivraisonId, userId]
    )
    pendingResult = { document_id: documentId, version, idempotent_replay: false }
    commitAttempted = true
    await db.query("COMMIT")
    committed = true
    return pendingResult
  } catch (error) {
    if (!commitAttempted) {
      await db.query("ROLLBACK").catch(() => undefined)
      throw error
    }

    db.release(error instanceof Error ? error : true)
    primaryConnectionReleased = true
    if (!pendingResult) {
      cleanupAllowed = false
      throw new HttpError(
        503,
        "LIVRAISON_PDF_COMMIT_UNCERTAIN",
        "L'etat de la generation PDF est incertain et doit etre reconcilie manuellement."
      )
    }

    let reconciled: PdfDocumentRow | null
    try {
      reconciled = await reconcilePdfCommit({ bonLivraisonId, userId, keyHash })
    } catch (reconciliationError) {
      cleanupAllowed = false
      throw uncertainPdfCommitError({
        result: pendingResult,
        commitError: error,
        reconciliationError,
      })
    }

    if (!reconciled) {
      throw error
    }
    if (
      reconciled.document_id !== pendingResult.document_id ||
      reconciled.version !== pendingResult.version
    ) {
      cleanupAllowed = false
      throw uncertainPdfCommitError({
        result: pendingResult,
        commitError: error,
        reconciliationError: new Error("The idempotency identity resolved to another PDF"),
      })
    }

    committed = true
    await assertStoredPdf(
      reconciled.document_id,
      reconciled.file_size_bytes,
      reconciled.checksum_sha256
    )
    return pendingResult
  } finally {
    if (!primaryConnectionReleased) db.release()
    if (!committed && cleanupAllowed) {
      await Promise.all(
        [temporaryPath, filePath]
          .filter((candidate): candidate is string => Boolean(candidate))
          .map((candidate) => fs.unlink(candidate).catch(() => undefined))
      )
    }
  }
}

export async function svcGetDocumentName(documentId: string) {
  return repoGetDocumentName(documentId)
}
