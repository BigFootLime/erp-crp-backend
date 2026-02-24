import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"

import pool from "../../../config/database"
import { HttpError } from "../../../utils/httpError"

import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"

import { repoGetLivraisonPackPreview } from "../repository/pack.repository"
import type { PackGenerateBodyDTO } from "../validators/pack.validators"
import type { LivraisonPackGenerateResult, LivraisonPackPreview } from "../types/pack.types"
import { svcRenderPackBonLivraisonPdf, svcRenderPackCofcPdf } from "./pack-pdf.service"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getPgErrorInfo(err: unknown) {
  if (!isRecord(err)) return { code: null as string | null, constraint: null as string | null }
  const code = typeof err.code === "string" ? err.code : null
  const constraint = typeof err.constraint === "string" ? err.constraint : null
  return { code, constraint }
}

function safeFileToken(input: string): string {
  const raw = String(input ?? "").trim()
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "_")
  return cleaned.length ? cleaned.slice(0, 80) : "BL"
}

async function ensureDocsDir(): Promise<string> {
  const baseDir = path.resolve("uploads/docs/livraisons")
  await fs.mkdir(baseDir, { recursive: true })
  return baseDir
}

async function getUserLabel(userId: number): Promise<string> {
  const res = await pool.query<{ username: string; name: string | null; surname: string | null }>(
    `SELECT username, name, surname FROM public.users WHERE id = $1`,
    [userId]
  )
  const row = res.rows[0] ?? null
  if (!row) throw new HttpError(400, "SIGNATAIRE_NOT_FOUND", "Unknown signataire_user_id")
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : null
  const surname = typeof row.surname === "string" && row.surname.trim() ? row.surname.trim() : null
  if (name && surname) return `${name} ${surname}`
  return row.username
}

async function insertEvent(db: { query: (sql: string, args?: unknown[]) => Promise<unknown> }, params: {
  bon_livraison_id: string
  event_type: string
  user_id: number | null
  old_values?: unknown | null
  new_values?: unknown | null
}) {
  await db.query(
    `
      INSERT INTO public.bon_livraison_event_log (bon_livraison_id, event_type, old_values, new_values, user_id)
      VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5)
    `,
    [
      params.bon_livraison_id,
      params.event_type,
      params.old_values === undefined ? null : JSON.stringify(params.old_values),
      params.new_values === undefined ? null : JSON.stringify(params.new_values),
      params.user_id,
    ]
  )
}

export async function svcGetLivraisonPackPreview(bonLivraisonId: string): Promise<LivraisonPackPreview> {
  return repoGetLivraisonPackPreview(bonLivraisonId)
}

function buildSummaryJson(args: {
  preview: LivraisonPackPreview
  version: number
  generated_by: number
  signataire_user_id: number
  include_documents: boolean
  commentaire_pack: string | null
  checksum_sha256: string
  bl_document_id: string
  cofc_document_id: string
}) {
  const p = args.preview
  return {
    pack: {
      version: args.version,
      generated_by: args.generated_by,
      signataire_user_id: args.signataire_user_id,
      include_documents: args.include_documents,
      commentaire_pack: args.commentaire_pack,
      checksum_sha256: args.checksum_sha256,
      bl_document_id: args.bl_document_id,
      cofc_document_id: args.cofc_document_id,
    },
    bon_livraison: {
      id: p.bon_livraison.id,
      numero: p.bon_livraison.numero,
      statut: p.bon_livraison.statut,
      date_creation: p.bon_livraison.date_creation,
      date_expedition: p.bon_livraison.date_expedition,
      date_livraison: p.bon_livraison.date_livraison,
      transporteur: p.bon_livraison.transporteur,
      tracking_number: p.bon_livraison.tracking_number,
      client: p.bon_livraison.client,
      commande: p.bon_livraison.commande,
      affaire: p.bon_livraison.affaire,
      adresse_livraison: p.bon_livraison.adresse_livraison,
    },
    lignes: p.lignes.map((l) => ({
      id: l.id,
      ordre: l.ordre,
      designation: l.designation,
      code_piece: l.code_piece,
      quantite: l.quantite,
      unite: l.unite,
      delai_client: l.delai_client,
      allocations: (l.allocations ?? []).map((a) => ({
        id: a.id,
        article_id: a.article_id,
        article_code: a.article.code,
        article_designation: a.article.designation,
        lot_id: a.lot_id,
        lot_code: a.lot?.lot_code ?? null,
        quantite: a.quantite,
        unite: a.unite,
        stock_movement_line_id: a.stock_movement_line_id,
      })),
    })),
    stock_movements: p.stock_movements.map((m) => ({
      id: m.id,
      movement_no: m.movement_no,
      movement_type: m.movement_type,
      status: m.status,
      effective_at: m.effective_at,
      posted_at: m.posted_at,
    })),
    documents_attached: args.include_documents
      ? p.documents_attached.map((d) => ({
          id: d.id,
          document_id: d.document_id,
          type: d.type,
          version: d.version,
          created_at: d.created_at,
          document_name: d.document_name,
          document_type: d.document_type,
        }))
      : [],
  }
}

export async function svcGenerateLivraisonPack(params: {
  bonLivraisonId: string
  actorUserId: number
  body: PackGenerateBodyDTO
}): Promise<LivraisonPackGenerateResult> {
  const preview = await repoGetLivraisonPackPreview(params.bonLivraisonId)

  if (!preview.checks.shipped_or_ready) {
    throw new HttpError(409, "BL_NOT_READY", "Bon de livraison must be READY/SHIPPED/DELIVERED before pack generation")
  }
  if (!preview.checks.allocations_ok) {
    throw new HttpError(400, "PACK_ALLOCATIONS_INVALID", "Allocations must be complete before pack generation")
  }

  const signataireUserId = params.body.signataire_user_id ?? params.actorUserId
  const signataireLabel = await getUserLabel(signataireUserId)
  const includeDocuments = params.body.include_documents
  const commentairePack = params.body.commentaire_pack?.trim() ? params.body.commentaire_pack.trim() : null

  const docsDir = await ensureDocsDir()
  const numeroToken = safeFileToken(preview.bon_livraison.numero)

  let attempt = 0
  while (attempt < 3) {
    attempt++

    const versionRes = await pool.query<{ version: string | number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM public.bon_livraison_pack_versions WHERE bon_livraison_id = $1::uuid`,
      [params.bonLivraisonId]
    )
    const versionRaw = versionRes.rows[0]?.version
    const version = typeof versionRaw === "number" ? versionRaw : typeof versionRaw === "string" ? Number(versionRaw) : NaN
    if (!Number.isInteger(version) || version <= 0) throw new Error("Failed to compute pack version")

    const blDocumentId = crypto.randomUUID()
    const cofcDocumentId = crypto.randomUUID()
    const blFileName = `BL_${numeroToken}_V${version}.pdf`
    const cofcFileName = `COFC_${numeroToken}_V${version}.pdf`
    const blPath = path.join(docsDir, `${blDocumentId}.pdf`)
    const cofcPath = path.join(docsDir, `${cofcDocumentId}.pdf`)

    const blPdf = await svcRenderPackBonLivraisonPdf({ preview, version })
    const cofcPdf = await svcRenderPackCofcPdf({
      preview,
      version,
      signataireLabel,
      commentairePack,
      includeDocuments,
    })

    const checksum = crypto.createHash("sha256").update(blPdf).update(cofcPdf).digest("hex")

    await fs.writeFile(blPath, blPdf)
    await fs.writeFile(cofcPath, cofcPdf)

    const db = await pool.connect()
    try {
      await db.query("BEGIN")

      await db.query(`INSERT INTO public.documents_clients (id, document_name, type) VALUES ($1, $2, $3)`, [
        blDocumentId,
        blFileName,
        "PDF",
      ])
      await db.query(`INSERT INTO public.documents_clients (id, document_name, type) VALUES ($1, $2, $3)`, [
        cofcDocumentId,
        cofcFileName,
        "PDF",
      ])

      const blRow = await db.query<{ id: string }>(
        `
          INSERT INTO public.bon_livraison_documents (bon_livraison_id, document_id, type, version, uploaded_by)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5)
          RETURNING id::text AS id
        `,
        [params.bonLivraisonId, blDocumentId, "GENERATED_BL_PDF", version, params.actorUserId]
      )
      const blDocRowId = blRow.rows[0]?.id
      if (!blDocRowId) throw new Error("Failed to create bon_livraison_documents row for BL PDF")

      const cofcRow = await db.query<{ id: string }>(
        `
          INSERT INTO public.bon_livraison_documents (bon_livraison_id, document_id, type, version, uploaded_by)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5)
          RETURNING id::text AS id
        `,
        [params.bonLivraisonId, cofcDocumentId, "GENERATED_COFC_PDF", version, params.actorUserId]
      )
      const cofcDocRowId = cofcRow.rows[0]?.id
      if (!cofcDocRowId) throw new Error("Failed to create bon_livraison_documents row for CofC PDF")

      const summaryJson = buildSummaryJson({
        preview,
        version,
        generated_by: params.actorUserId,
        signataire_user_id: signataireUserId,
        include_documents: includeDocuments,
        commentaire_pack: commentairePack,
        checksum_sha256: checksum,
        bl_document_id: blDocumentId,
        cofc_document_id: cofcDocumentId,
      })

      const packIns = await db.query<{ id: string }>(
        `
          INSERT INTO public.bon_livraison_pack_versions (
            bon_livraison_id,
            version,
            status,
            generated_by,
            bl_pdf_document_id,
            cofc_pdf_document_id,
            summary_json,
            checksum_sha256,
            created_by,
            updated_by
          )
          VALUES ($1::uuid, $2, 'GENERATED', $3, $4::uuid, $5::uuid, $6::jsonb, $7, $8, $8)
          RETURNING id::text AS id
        `,
        [
          params.bonLivraisonId,
          version,
          params.actorUserId,
          blDocRowId,
          cofcDocRowId,
          JSON.stringify(summaryJson),
          checksum,
          params.actorUserId,
        ]
      )
      const packVersionId = packIns.rows[0]?.id
      if (!packVersionId) throw new Error("Failed to create bon_livraison_pack_versions row")

      await insertEvent(db, {
        bon_livraison_id: params.bonLivraisonId,
        event_type: version > 1 ? "PACK_REGENERATED" : "PACK_GENERATED",
        user_id: params.actorUserId,
        new_values: {
          pack_version_id: packVersionId,
          version,
          bl_document_id: blDocumentId,
          cofc_document_id: cofcDocumentId,
          checksum_sha256: checksum,
          signataire_user_id: signataireUserId,
          include_documents: includeDocuments,
        },
      })

      await db.query(`UPDATE public.bon_livraison SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`, [
        params.bonLivraisonId,
        params.actorUserId,
      ])

      await repoInsertAuditLog({
        user_id: params.actorUserId,
        body: {
          event_type: "ACTION",
          action: "livraisons.pack.generated",
          page_key: "livraisons",
          entity_type: "bon_livraison",
          entity_id: params.bonLivraisonId,
          path: `/api/v1/livraisons/${params.bonLivraisonId}/pack/generate`,
          client_session_id: null,
          details: {
            bon_livraison_numero: preview.bon_livraison.numero,
            version,
            pack_version_id: packVersionId,
            bl_document_id: blDocumentId,
            cofc_document_id: cofcDocumentId,
            checksum_sha256: checksum,
          },
        },
        ip: null,
        user_agent: null,
        device_type: null,
        os: null,
        browser: null,
        tx: db,
      })

      await db.query("COMMIT")
      return {
        pack_version_id: packVersionId,
        version,
        bl_document_id: blDocumentId,
        cofc_document_id: cofcDocumentId,
      }
    } catch (err) {
      await db.query("ROLLBACK")
      await fs.unlink(blPath).catch(() => undefined)
      await fs.unlink(cofcPath).catch(() => undefined)

      const pg = getPgErrorInfo(err)
      if (pg.code === "23505" && (pg.constraint ?? "").includes("bon_livraison_pack_versions_bl_version_uniq")) {
        continue
      }
      throw err
    } finally {
      db.release()
    }
  }

  throw new Error("Failed to generate pack after retries")
}

export async function svcRevokeLivraisonPackVersion(params: {
  bonLivraisonId: string
  versionId: string
  actorUserId: number
}): Promise<{ id: string; status: "REVOKED"; version: number }> {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")

    const res = await db.query<{ id: string; version: number }>(
      `
        UPDATE public.bon_livraison_pack_versions
        SET status = 'REVOKED', updated_at = now(), updated_by = $3
        WHERE id = $2::uuid AND bon_livraison_id = $1::uuid
        RETURNING id::text AS id, version
      `,
      [params.bonLivraisonId, params.versionId, params.actorUserId]
    )
    const row = res.rows[0] ?? null
    if (!row) throw new HttpError(404, "PACK_VERSION_NOT_FOUND", "Pack version not found")

    await insertEvent(db, {
      bon_livraison_id: params.bonLivraisonId,
      event_type: "PACK_REVOKED",
      user_id: params.actorUserId,
      new_values: { pack_version_id: row.id, version: row.version },
    })

    await repoInsertAuditLog({
      user_id: params.actorUserId,
      body: {
        event_type: "ACTION",
        action: "livraisons.pack.revoked",
        page_key: "livraisons",
        entity_type: "bon_livraison",
        entity_id: params.bonLivraisonId,
        path: `/api/v1/livraisons/${params.bonLivraisonId}/pack/revoke/${params.versionId}`,
        client_session_id: null,
        details: {
          pack_version_id: row.id,
          version: row.version,
        },
      },
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      tx: db,
    })

    await db.query("COMMIT")
    return { id: row.id, status: "REVOKED", version: row.version }
  } catch (err) {
    await db.query("ROLLBACK")
    throw err
  } finally {
    db.release()
  }
}
