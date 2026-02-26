import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import pool from "../../../config/database"
import { HttpError } from "../../../utils/httpError"

import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"

import type { AsbuiltGenerateBodyDTO } from "../validators/asbuilt.validators"
import type { AsBuiltGenerateResult, AsBuiltPreview } from "../types/asbuilt.types"

import {
  buildAsbuiltFileName,
  repoComputeNextAsbuiltVersion,
  repoCountNcForLot,
  repoFindAsbuiltDocumentFilePath,
  repoGetLotHeader,
  repoGetUserLabel,
  repoInsertAsbuiltPackVersionTx,
  repoInsertDocumentsClientTx,
  repoIsAsbuiltDocumentLinked,
  repoListBonLivraisonsForLot,
  repoListNonConformitiesForLot,
  repoListOfsForLot,
  repoListPackVersions,
} from "../repository/asbuilt.repository"

import { svcRenderAsbuiltPdf } from "./asbuilt-pdf.service"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getPgErrorInfo(err: unknown) {
  if (!isRecord(err)) return { code: null as string | null, constraint: null as string | null }
  const code = typeof err.code === "string" ? err.code : null
  const constraint = typeof err.constraint === "string" ? err.constraint : null
  return { code, constraint }
}

async function ensureDocsDir(): Promise<string> {
  const baseDir = path.resolve("uploads/docs/asbuilt")
  await fs.mkdir(baseDir, { recursive: true })
  return baseDir
}

function buildSummaryJson(
  preview: AsBuiltPreview,
  args: {
    version: number
    generated_by: number
    signataire_user_id: number
    commentaire: string | null
    pdf_document_id: string
  }
) {
  return {
    asbuilt: {
      version: args.version,
      generated_by: args.generated_by,
      signataire_user_id: args.signataire_user_id,
      commentaire: args.commentaire,
      pdf_document_id: args.pdf_document_id,
    },
    lot: {
      id: preview.lot.id,
      lot_code: preview.lot.lot_code,
      article_id: preview.lot.article_id,
      article_code: preview.lot.article_code,
      article_designation: preview.lot.article_designation,
    },
    links: {
      of_ids: preview.ofs.map((o) => o.id),
      bon_livraison_ids: preview.bon_livraisons.map((b) => b.id),
      non_conformity_ids: preview.non_conformities.map((n) => n.id),
    },
    checks: preview.checks,
  }
}

export async function svcGetAsbuiltPreview(lotId: string): Promise<AsBuiltPreview> {
  const lot = await repoGetLotHeader(lotId)
  if (!lot) throw new HttpError(404, "LOT_NOT_FOUND", "Lot introuvable")

  const [ofs, bonLivraisons, ncs, packVersions, ncCounts] = await Promise.all([
    repoListOfsForLot(lotId),
    repoListBonLivraisonsForLot(lotId),
    repoListNonConformitiesForLot(lotId),
    repoListPackVersions(lotId),
    repoCountNcForLot(lotId),
  ])

  return {
    lot,
    ofs,
    bon_livraisons: bonLivraisons,
    non_conformities: ncs,
    pack_versions: packVersions,
    checks: {
      open_non_conformities: ncCounts.open,
      overdue_non_conformities: ncCounts.overdue,
      has_of_link: ofs.length > 0,
      has_shipping_link: bonLivraisons.length > 0,
    },
  }
}

export async function svcGenerateAsbuiltPack(params: {
  lotId: string
  actorUserId: number
  body: AsbuiltGenerateBodyDTO
}): Promise<AsBuiltGenerateResult> {
  const preview = await svcGetAsbuiltPreview(params.lotId)

  const signataireUserId = params.body.signataire_user_id ?? params.actorUserId
  const signataireLabel = await repoGetUserLabel(signataireUserId)
  const commentaire = params.body.commentaire?.trim() ? params.body.commentaire.trim() : null

  const docsDir = await ensureDocsDir()

  let attempt = 0
  while (attempt < 3) {
    attempt += 1

    const version = await repoComputeNextAsbuiltVersion(params.lotId)
    const pdfDocumentId = crypto.randomUUID()
    const fileName = buildAsbuiltFileName({ lot_code: preview.lot.lot_code, version })
    const filePath = path.join(docsDir, `${pdfDocumentId}.pdf`)

    const generatedAt = new Date()
    const pdfBuffer = await svcRenderAsbuiltPdf({
      preview,
      version,
      generatedAt,
      signataireLabel,
      commentaire,
    })

    await fs.writeFile(filePath, pdfBuffer)

    const tx = await pool.connect()
    try {
      await tx.query("BEGIN")

      await repoInsertDocumentsClientTx(tx, {
        documentId: pdfDocumentId,
        documentName: fileName,
        type: "PDF",
      })

      const summaryJson = buildSummaryJson(preview, {
        version,
        generated_by: params.actorUserId,
        signataire_user_id: signataireUserId,
        commentaire,
        pdf_document_id: pdfDocumentId,
      })

      const asbuiltVersionId = await repoInsertAsbuiltPackVersionTx(tx, {
        lotId: params.lotId,
        version,
        actorUserId: params.actorUserId,
        signataireUserId,
        commentaire,
        pdfDocumentId,
        summaryJson,
      })

      await repoInsertAuditLog({
        user_id: params.actorUserId,
        body: {
          event_type: "ACTION",
          action: "asbuilt.pack.generated",
          page_key: "traceabilite",
          entity_type: "lots",
          entity_id: params.lotId,
          path: `/api/v1/asbuilt/lots/${params.lotId}/generate`,
          client_session_id: null,
          details: {
            lot_code: preview.lot.lot_code,
            version,
            asbuilt_version_id: asbuiltVersionId,
            pdf_document_id: pdfDocumentId,
          },
        },
        ip: null,
        user_agent: null,
        device_type: null,
        os: null,
        browser: null,
        tx,
      })

      await tx.query("COMMIT")
      return {
        asbuilt_version_id: asbuiltVersionId,
        version,
        pdf_document_id: pdfDocumentId,
      }
    } catch (err) {
      await tx.query("ROLLBACK")
      await fs.unlink(filePath).catch(() => undefined)

      const pg = getPgErrorInfo(err)
      if (pg.code === "23505" && (pg.constraint ?? "").includes("asbuilt_pack_versions_lot_version_uniq")) {
        continue
      }
      throw err
    } finally {
      tx.release()
    }
  }

  throw new Error("Failed to generate as-built pack after retries")
}

export async function svcResolveAsbuiltDocument(params: {
  lotId: string
  documentId: string
}): Promise<{ filePath: string; name: string }> {
  const linked = await repoIsAsbuiltDocumentLinked(params.lotId, params.documentId)
  if (!linked) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document introuvable")

  const filePath = await repoFindAsbuiltDocumentFilePath(params.documentId)
  if (!filePath) throw new HttpError(404, "FILE_NOT_FOUND", "Fichier introuvable")

  const name = path.basename(filePath)
  return { filePath, name }
}
