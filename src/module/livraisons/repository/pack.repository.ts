import pool from "../../../config/database"
import { HttpError } from "../../../utils/httpError"

import type { LivraisonPackPreview, LivraisonPackStockMovement, LivraisonPackVersion, LivraisonPackAllocation } from "../types/pack.types"
import type { BonLivraisonDocument, BonLivraisonLigne } from "../types/livraisons.types"
import { repoGetLivraisonDetail } from "./livraisons.repository"

function almostEqual(a: number, b: number, tolerance = 0.0001): boolean {
  return Math.abs(a - b) <= tolerance
}

function computeAllocationChecks(lines: Array<Pick<BonLivraisonLigne, "quantite" | "allocations">>): {
  allocations_ok: boolean
  missing: string[]
} {
  let anyMissing = false
  let anyMismatch = false

  for (const line of lines) {
    const allocs = line.allocations ?? []
    if (!allocs.length) {
      anyMissing = true
      continue
    }
    const sum = allocs.reduce((acc, a) => acc + (Number.isFinite(a.quantite) ? a.quantite : 0), 0)
    if (!almostEqual(sum, line.quantite)) anyMismatch = true
  }

  const allocations_ok = !anyMissing && !anyMismatch
  const missing: string[] = []
  if (anyMissing) missing.push("ALLOCATIONS_REQUIRED")
  if (anyMismatch) missing.push("ALLOCATIONS_MISMATCH")
  return { allocations_ok, missing }
}

export async function repoGetLivraisonPackPreview(bonLivraisonId: string): Promise<LivraisonPackPreview> {
  const detail = await repoGetLivraisonDetail(bonLivraisonId)
  if (!detail) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")

  type EnrichRow = {
    allocation_id: string
    article_code: string | null
    article_designation: string | null
    lot_code: string | null
  }

  const enrichRes = await pool.query<EnrichRow>(
    `
      SELECT
        a.id::text AS allocation_id,
        art.code AS article_code,
        art.designation AS article_designation,
        l.lot_code AS lot_code
      FROM public.bon_livraison_ligne_allocations a
      JOIN public.bon_livraison_ligne bl ON bl.id = a.bon_livraison_ligne_id
      LEFT JOIN public.articles art ON art.id = a.article_id
      LEFT JOIN public.lots l ON l.id = a.lot_id
      WHERE bl.bon_livraison_id = $1::uuid
    `,
    [bonLivraisonId]
  )

  const enrichByAllocationId = new Map<string, EnrichRow>()
  for (const r of enrichRes.rows) enrichByAllocationId.set(r.allocation_id, r)

  const lignes = detail.lignes.map((l) => {
    const allocations: LivraisonPackAllocation[] = (l.allocations ?? []).map((a) => {
      const ex = enrichByAllocationId.get(a.id) ?? null
      return {
        ...a,
        article: {
          code: ex?.article_code ?? null,
          designation: ex?.article_designation ?? null,
        },
        lot: ex?.lot_code ? { lot_code: ex.lot_code } : null,
      }
    })
    return { ...l, allocations }
  })

  type MovementRow = {
    id: string
    movement_no: string | null
    movement_type: string
    status: string
    effective_at: string | null
    posted_at: string | null
  }

  const movementsRes = await pool.query<MovementRow>(
    `
      SELECT
        m.id::text AS id,
        m.movement_no,
        m.movement_type::text AS movement_type,
        m.status,
        m.effective_at::text AS effective_at,
        m.posted_at::text AS posted_at
      FROM public.stock_movements m
      WHERE m.source_document_type = 'BON_LIVRAISON'
        AND m.source_document_id = $1
        AND m.movement_type = 'OUT'::public.movement_type
      ORDER BY m.posted_at DESC NULLS LAST, m.effective_at DESC, m.id DESC
      LIMIT 200
    `,
    [bonLivraisonId]
  )

  const stock_movements: LivraisonPackStockMovement[] = movementsRes.rows.map((r) => ({
    id: r.id,
    movement_no: r.movement_no,
    movement_type: r.movement_type,
    status: r.status,
    effective_at: r.effective_at,
    posted_at: r.posted_at,
  }))

  type PackVersionRow = {
    id: string
    bon_livraison_id: string
    version: number
    status: string
    generated_at: string
    generated_by_id: number | null
    generated_by_username: string | null
    generated_by_name: string | null
    generated_by_surname: string | null
    bl_doc_row_id: string | null
    bl_document_id: string | null
    bl_document_name: string | null
    cofc_doc_row_id: string | null
    cofc_document_id: string | null
    cofc_document_name: string | null
    checksum_sha256: string | null
  }

  const packVersionsRes = await pool.query<PackVersionRow>(
    `
      SELECT
        pv.id::text AS id,
        pv.bon_livraison_id::text AS bon_livraison_id,
        pv.version,
        pv.status,
        pv.generated_at::text AS generated_at,
        u.id AS generated_by_id,
        u.username AS generated_by_username,
        u.name AS generated_by_name,
        u.surname AS generated_by_surname,
        blDoc.id::text AS bl_doc_row_id,
        blDoc.document_id::text AS bl_document_id,
        blDc.document_name AS bl_document_name,
        cofcDoc.id::text AS cofc_doc_row_id,
        cofcDoc.document_id::text AS cofc_document_id,
        cofcDc.document_name AS cofc_document_name,
        pv.checksum_sha256
      FROM public.bon_livraison_pack_versions pv
      LEFT JOIN public.users u ON u.id = pv.generated_by
      LEFT JOIN public.bon_livraison_documents blDoc ON blDoc.id = pv.bl_pdf_document_id
      LEFT JOIN public.documents_clients blDc ON blDc.id = blDoc.document_id
      LEFT JOIN public.bon_livraison_documents cofcDoc ON cofcDoc.id = pv.cofc_pdf_document_id
      LEFT JOIN public.documents_clients cofcDc ON cofcDc.id = cofcDoc.document_id
      WHERE pv.bon_livraison_id = $1::uuid
      ORDER BY pv.version DESC, pv.generated_at DESC, pv.id DESC
      LIMIT 200
    `,
    [bonLivraisonId]
  )

  const pack_versions: LivraisonPackVersion[] = packVersionsRes.rows.map((r) => {
    const generatedBy =
      typeof r.generated_by_id === "number" && r.generated_by_id > 0 && typeof r.generated_by_username === "string" && r.generated_by_username.trim()
        ? {
            id: r.generated_by_id,
            username: r.generated_by_username,
            name: r.generated_by_name,
            surname: r.generated_by_surname,
            label: r.generated_by_name && r.generated_by_surname ? `${r.generated_by_name} ${r.generated_by_surname}` : r.generated_by_username,
          }
        : null

    return {
      id: r.id,
      bon_livraison_id: r.bon_livraison_id,
      version: r.version,
      status: r.status === "REVOKED" ? "REVOKED" : "GENERATED",
      generated_at: r.generated_at,
      generated_by: generatedBy,
      bl_pdf_document:
        r.bl_doc_row_id && r.bl_document_id
          ? {
              bon_livraison_document_id: r.bl_doc_row_id,
              document_id: r.bl_document_id,
              document_name: r.bl_document_name,
            }
          : null,
      cofc_pdf_document:
        r.cofc_doc_row_id && r.cofc_document_id
          ? {
              bon_livraison_document_id: r.cofc_doc_row_id,
              document_id: r.cofc_document_id,
              document_name: r.cofc_document_name,
            }
          : null,
      checksum_sha256: r.checksum_sha256,
    }
  })

  const generatedDocIds = new Set<string>()
  for (const v of pack_versions) {
    if (v.bl_pdf_document?.document_id) generatedDocIds.add(v.bl_pdf_document.document_id)
    if (v.cofc_pdf_document?.document_id) generatedDocIds.add(v.cofc_pdf_document.document_id)
  }

  const documents_generated: BonLivraisonDocument[] = []
  const documents_attached: BonLivraisonDocument[] = []
  for (const d of detail.documents) {
    if (generatedDocIds.has(d.document_id)) documents_generated.push(d)
    else documents_attached.push(d)
  }

  const allocCheck = computeAllocationChecks(lignes)
  const shipped_or_ready = ["READY", "SHIPPED", "DELIVERED"].includes(detail.bon_livraison.statut)
  const stock_link_ok =
    detail.bon_livraison.statut === "SHIPPED" || detail.bon_livraison.statut === "DELIVERED" ? stock_movements.length > 0 : true

  const missing: string[] = []
  if (!shipped_or_ready) missing.push("BL_NOT_READY")
  missing.push(...allocCheck.missing)
  if (!stock_link_ok) missing.push("STOCK_LINK_MISSING")

  return {
    bon_livraison: detail.bon_livraison,
    lignes,
    stock_movements,
    documents_attached,
    documents_generated,
    pack_versions,
    checks: {
      allocations_ok: allocCheck.allocations_ok,
      shipped_or_ready,
      stock_link_ok,
      missing,
    },
  }
}
