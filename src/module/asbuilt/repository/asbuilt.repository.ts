import fs from "node:fs/promises"
import path from "node:path"

import type { PoolClient } from "pg"

import pool from "../../../config/database"
import { HttpError } from "../../../utils/httpError"

import type {
  AsBuiltBonLivraisonLite,
  AsBuiltLotHeader,
  AsBuiltNonConformityLite,
  AsBuiltOfLite,
  AsBuiltPackVersion,
} from "../types/asbuilt.types"

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10)
  throw new Error(`Invalid ${label}: ${String(value)}`)
}

function toNullableInt(value: unknown, label = "id"): number | null {
  if (value === null || value === undefined) return null
  return toInt(value, label)
}

function safeFileToken(input: string): string {
  const raw = String(input ?? "").trim()
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "_")
  return cleaned.length ? cleaned.slice(0, 80) : "LOT"
}

export async function repoGetLotHeader(lotId: string): Promise<AsBuiltLotHeader | null> {
  const res = await pool.query<AsBuiltLotHeader>(
    `
      SELECT
        l.id::text AS id,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        l.lot_code,
        l.supplier_lot_code,
        l.received_at::text AS received_at,
        l.manufactured_at::text AS manufactured_at,
        l.expiry_at::text AS expiry_at,
        l.notes,
        l.created_at::text AS created_at,
        l.updated_at::text AS updated_at
      FROM public.lots l
      JOIN public.articles a ON a.id = l.article_id
      WHERE l.id = $1::uuid
      LIMIT 1
    `,
    [lotId]
  )
  return res.rows[0] ?? null
}

export async function repoListOfsForLot(lotId: string): Promise<AsBuiltOfLite[]> {
  const res = await pool.query<{
    id: string
    numero: string
    statut: string
    priority: string | null
    affaire_id: string | null
    commande_id: string | null
    piece_technique_id: string
    piece_code: string
    piece_designation: string
    quantite_lancee: number
    quantite_bonne: number
    quantite_rebut: number
  }>(
    `
      SELECT
        o.id::text AS id,
        o.numero,
        o.statut::text AS statut,
        o.priority::text AS priority,
        o.affaire_id::text AS affaire_id,
        o.commande_id::text AS commande_id,
        o.piece_technique_id::text AS piece_technique_id,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation,
        o.quantite_lancee::float8 AS quantite_lancee,
        o.quantite_bonne::float8 AS quantite_bonne,
        o.quantite_rebut::float8 AS quantite_rebut
      FROM public.of_output_lots ool
      JOIN public.ordres_fabrication o ON o.id = ool.of_id
      JOIN public.pieces_techniques pt ON pt.id = o.piece_technique_id
      WHERE ool.lot_id = $1::uuid
      ORDER BY o.id DESC
      LIMIT 50
    `,
    [lotId]
  )

  return res.rows.map((r) => ({
    id: toInt(r.id, "ordres_fabrication.id"),
    numero: r.numero,
    statut: r.statut,
    priority: r.priority,
    affaire_id: toNullableInt(r.affaire_id, "ordres_fabrication.affaire_id"),
    commande_id: toNullableInt(r.commande_id, "ordres_fabrication.commande_id"),
    piece_technique_id: r.piece_technique_id,
    piece_code: r.piece_code,
    piece_designation: r.piece_designation,
    quantite_lancee: Number(r.quantite_lancee),
    quantite_bonne: Number(r.quantite_bonne),
    quantite_rebut: Number(r.quantite_rebut),
  }))
}

export async function repoListBonLivraisonsForLot(lotId: string): Promise<AsBuiltBonLivraisonLite[]> {
  const res = await pool.query<{
    id: string
    numero: string
    statut: string
    date_creation: string | null
    date_livraison: string | null
    transporteur: string | null
    tracking_number: string | null
    reception_nom_signataire: string | null
    reception_date_signature: string | null
    commande_id: string | null
    affaire_id: string | null
  }>(
    `
      SELECT
        bl.id::text AS id,
        bl.numero,
        bl.statut,
        bl.date_creation::text AS date_creation,
        bl.date_livraison::text AS date_livraison,
        bl.transporteur,
        bl.tracking_number,
        bl.reception_nom_signataire,
        bl.reception_date_signature::text AS reception_date_signature,
        bl.commande_id::text AS commande_id,
        bl.affaire_id::text AS affaire_id
      FROM public.bon_livraison_ligne_allocations a
      JOIN public.bon_livraison_ligne l ON l.id = a.bon_livraison_ligne_id
      JOIN public.bon_livraison bl ON bl.id = l.bon_livraison_id
      WHERE a.lot_id = $1::uuid
      GROUP BY bl.id
      ORDER BY MAX(bl.created_at) DESC, bl.id DESC
      LIMIT 50
    `,
    [lotId]
  )

  return res.rows.map((r) => ({
    id: r.id,
    numero: r.numero,
    statut: r.statut,
    date_creation: r.date_creation,
    date_livraison: r.date_livraison,
    transporteur: r.transporteur,
    tracking_number: r.tracking_number,
    reception_nom_signataire: r.reception_nom_signataire,
    reception_date_signature: r.reception_date_signature,
    commande_id: toNullableInt(r.commande_id, "bon_livraison.commande_id"),
    affaire_id: toNullableInt(r.affaire_id, "bon_livraison.affaire_id"),
  }))
}

export async function repoListNonConformitiesForLot(lotId: string): Promise<AsBuiltNonConformityLite[]> {
  const res = await pool.query<AsBuiltNonConformityLite>(
    `
      SELECT
        nc.id::text AS id,
        nc.reference,
        nc.status::text AS status,
        nc.severity::text AS severity,
        nc.detection_date::text AS detection_date,
        nc.due_date::text AS due_date,
        nc.description
      FROM public.non_conformity nc
      WHERE nc.lot_id = $1::uuid
      ORDER BY nc.detection_date DESC, nc.id DESC
      LIMIT 200
    `,
    [lotId]
  )
  return res.rows
}

export async function repoCountNcForLot(lotId: string): Promise<{ open: number; overdue: number }> {
  const res = await pool.query<{ open_total: number; overdue_total: number }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE nc.status <> 'CLOSED')::int AS open_total,
        COUNT(*) FILTER (WHERE nc.status <> 'CLOSED' AND nc.due_date IS NOT NULL AND nc.due_date < CURRENT_DATE)::int AS overdue_total
      FROM public.non_conformity nc
      WHERE nc.lot_id = $1::uuid
    `,
    [lotId]
  )
  return { open: res.rows[0]?.open_total ?? 0, overdue: res.rows[0]?.overdue_total ?? 0 }
}

export async function repoListPackVersions(lotId: string): Promise<AsBuiltPackVersion[]> {
  const res = await pool.query<{
    id: string
    lot_fg_id: string
    version: number
    status: string
    generated_at: string
    generated_by_id: number | null
    generated_by_username: string | null
    generated_by_name: string | null
    generated_by_surname: string | null
    signataire_user_id: number | null
    commentaire: string | null
    pdf_document_id: string | null
    pdf_document_name: string | null
  }>(
    `
      SELECT
        v.id::text AS id,
        v.lot_fg_id::text AS lot_fg_id,
        v.version,
        v.status,
        v.generated_at::text AS generated_at,
        u.id AS generated_by_id,
        u.username AS generated_by_username,
        u.name AS generated_by_name,
        u.surname AS generated_by_surname,
        v.signataire_user_id,
        v.commentaire,
        v.pdf_document_id::text AS pdf_document_id,
        dc.document_name AS pdf_document_name
      FROM public.asbuilt_pack_versions v
      LEFT JOIN public.users u ON u.id = v.generated_by
      LEFT JOIN public.documents_clients dc ON dc.id = v.pdf_document_id
      WHERE v.lot_fg_id = $1::uuid
      ORDER BY v.version DESC, v.generated_at DESC, v.id DESC
      LIMIT 200
    `,
    [lotId]
  )

  return res.rows.map((r) => {
    const generated_by =
      typeof r.generated_by_id === "number" && r.generated_by_username
        ? {
            id: r.generated_by_id,
            username: r.generated_by_username,
            name: r.generated_by_name,
            surname: r.generated_by_surname,
            label:
              r.generated_by_name && r.generated_by_surname
                ? `${r.generated_by_name} ${r.generated_by_surname}`
                : r.generated_by_username,
          }
        : null

    return {
      id: r.id,
      lot_fg_id: r.lot_fg_id,
      version: r.version,
      status: r.status === "REVOKED" ? "REVOKED" : "GENERATED",
      generated_at: r.generated_at,
      generated_by,
      signataire_user_id: r.signataire_user_id,
      commentaire: r.commentaire,
      pdf_document_id: r.pdf_document_id,
      pdf_document_name: r.pdf_document_name,
    }
  })
}

export async function repoComputeNextAsbuiltVersion(lotId: string): Promise<number> {
  const res = await pool.query<{ version: string | number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM public.asbuilt_pack_versions WHERE lot_fg_id = $1::uuid`,
    [lotId]
  )
  const raw = res.rows[0]?.version
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
  if (!Number.isInteger(n) || n <= 0) throw new Error("Failed to compute asbuilt version")
  return n
}

export async function repoGetUserLabel(userId: number): Promise<string> {
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

type DbQueryer = Pick<PoolClient, "query">

export async function repoInsertDocumentsClientTx(
  tx: DbQueryer,
  params: { documentId: string; documentName: string; type: string }
) {
  await tx.query(`INSERT INTO public.documents_clients (id, document_name, type) VALUES ($1, $2, $3)`, [
    params.documentId,
    params.documentName,
    params.type,
  ])
}

export async function repoInsertAsbuiltPackVersionTx(
  tx: DbQueryer,
  params: {
    lotId: string
    version: number
    actorUserId: number
    signataireUserId: number | null
    commentaire: string | null
    pdfDocumentId: string
    summaryJson: unknown
  }
): Promise<string> {
  const ins = await tx.query<{ id: string }>(
    `
      INSERT INTO public.asbuilt_pack_versions (
        lot_fg_id,
        version,
        status,
        generated_by,
        signataire_user_id,
        commentaire,
        pdf_document_id,
        summary_json,
        created_by,
        updated_by
      )
      VALUES ($1::uuid,$2,'GENERATED',$3,$4,$5,$6::uuid,$7::jsonb,$3,$3)
      RETURNING id::text AS id
    `,
    [
      params.lotId,
      params.version,
      params.actorUserId,
      params.signataireUserId,
      params.commentaire,
      params.pdfDocumentId,
      JSON.stringify(params.summaryJson ?? {}),
    ]
  )
  const id = ins.rows[0]?.id
  if (!id) throw new Error("Failed to create asbuilt_pack_versions row")
  return id
}

async function ensureDocsDir(): Promise<string> {
  const baseDir = path.resolve("uploads/docs/asbuilt")
  await fs.mkdir(baseDir, { recursive: true })
  return baseDir
}

export async function repoFindAsbuiltDocumentFilePath(documentId: string): Promise<string | null> {
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

export async function repoIsAsbuiltDocumentLinked(lotId: string, documentId: string): Promise<boolean> {
  const res = await pool.query(
    `
      SELECT 1
      FROM public.asbuilt_pack_versions
      WHERE lot_fg_id = $1::uuid
        AND pdf_document_id = $2::uuid
        AND status = 'GENERATED'
      LIMIT 1
    `,
    [lotId, documentId]
  )
  return (res.rowCount ?? 0) > 0
}

export function buildAsbuiltFileName(params: { lot_code: string; version: number }): string {
  const token = safeFileToken(params.lot_code)
  return `DOSSIER_LOT_${token}_V${params.version}.pdf`
}
