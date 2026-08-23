import type { PoolClient } from "pg"

import pool from "../../../config/database"
import {
  evaluateDeliveryQualityRelease,
  type DeliveryQualityDerogation,
  type DeliveryQualityEvidence,
  type DeliveryQualityPolicy,
  type DeliveryQualityRelease,
  type DeliveryQualityTargetObservation,
} from "../domain/quality-release-gate"

type Queryable = Pick<PoolClient, "query">

/**
 * Serializes a legal invoice's delivery-quality decision with shipment and
 * Quality mutations. The delivery row lock closes allocation changes; the
 * deterministic advisory keys close predicate races for a new NC/derogation
 * that refers to an already-selected delivery lot.
 */
export async function lockDeliveryQualityReleaseScope(db: Queryable, bonLivraisonId: string): Promise<void> {
  await db.query(`SELECT id FROM public.bon_livraison WHERE id = $1::uuid FOR UPDATE`, [bonLivraisonId]);
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`quality-delivery:${bonLivraisonId}`]);
  const lots = await db.query<{ lot_id: string }>(`
    SELECT DISTINCT a.lot_id::text AS lot_id
    FROM public.bon_livraison_ligne_allocations a
    JOIN public.bon_livraison_ligne line ON line.id = a.bon_livraison_ligne_id
    WHERE line.bon_livraison_id = $1::uuid AND a.lot_id IS NOT NULL
    ORDER BY a.lot_id::text
  `, [bonLivraisonId]);
  for (const row of lots.rows) {
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`quality-lot:${row.lot_id}`]);
  }
}

type TargetRow = {
  target_key: string
  allocation_id: string
  delivery_line_id: string
  object_type: "LOT" | "DELIVERY_LINE"
  object_id: string
  label: string | null
  qty_requested: string
  unite: string | null
  lot_status: "LIBERE" | "EN_ATTENTE" | "QUARANTAINE" | "BLOQUE" | null
  article_id: string | null
  article_code: string | null
  article_designation: string | null
  lot_id: string | null
  lot_code: string | null
  commande_id: string | null
  plan_id: string | null
  plan_code: string | null
  plan_version: number | null
}

type ControlRow = {
  id: string
  delivery_allocation_id: string | null
  source_type: string
  source_id: string
  qty_released: string
  qty_held: string
  qty_consumed: string
  pending: boolean
}

type NcRow = {
  id: string
  control_id: string | null
  lot_id: string | null
  bon_livraison_id: string | null
  open_without_disposition: boolean
}

type ReleaseRow = {
  id: string
  quality_control_id: string
  decision: "FULL" | "PARTIAL" | "HOLD" | "REJECT"
  qty: string
  object_type: string
  object_id: string
  derogation_id: string | null
  justification: string | null
  decided_at: string
  d_code: string | null
  d_status: string | null
  d_article_id: string | null
  d_piece_technique_id: string | null
  d_piece_version_id: string | null
  d_lot_id: string | null
  d_of_id: string | null
  d_commande_id: string | null
  d_bon_livraison_id: string | null
  d_max_qty: string | null
  d_unite: string | null
  d_consumed_qty: string | null
  d_valid_from: string | null
  d_valid_to: string | null
  d_requested_by: number | null
  d_requested_at: string | null
  d_approved_by: number | null
  d_approved_at: string | null
  d_requirement: string | null
  d_deviation: string | null
  consumption_id: string | null
  consumption_bon_livraison_id: string | null
  consumption_qty: string | null
}

type EvidenceRow = {
  id: string
  entity_type: DeliveryQualityEvidence["entity_type"]
  entity_id: string
  document_type: string
  version: number
  revision: string | null
  original_name: string
  mime_type: string
  size_bytes: string
  sha256: string
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function pgCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null
  return typeof error.code === "string" ? error.code : null
}

const FAIL_CLOSED_SCHEMA_CODES = new Set(["42P01", "42703", "42704", "42883"])

function unknownRelease(bonLivraisonId: string, reason: string): DeliveryQualityRelease {
  return evaluateDeliveryQualityRelease({
    bon_livraison_id: bonLivraisonId,
    evaluated_at: new Date().toISOString(),
    policy_candidates: [],
    targets: [],
    evidence: [],
    unavailable_reason: reason,
  })
}

/**
 * Builds the canonical quality release aggregate for one delivery. All reads
 * can use the caller's transaction so generation and shipment re-check the
 * exact state they commit against.
 */
export async function repoGetDeliveryQualityRelease(
  bonLivraisonId: string,
  db: Queryable = pool
): Promise<DeliveryQualityRelease> {
  try {
    const clockRes = await db.query<{ evaluated_at: string }>(`SELECT clock_timestamp()::text AS evaluated_at`)
    const evaluatedAt = clockRes.rows[0]?.evaluated_at ?? new Date().toISOString()

    const policiesRes = await db.query<{
      id: string
      code: string
      version: number
      rules: unknown
      rules_sha256: string
      signature_reference: string
      signed_at: string
    }>(
      `
        SELECT id::text AS id, code, version, rules, rules_sha256,
               signature_reference, signed_at::text AS signed_at
        FROM public.quality_delivery_release_policy
        WHERE status = 'ACTIVE'
          AND signed_at IS NOT NULL
          AND valid_from <= clock_timestamp()
          AND (valid_to IS NULL OR valid_to >= clock_timestamp())
        ORDER BY version DESC, id
        LIMIT 2
      `
    )
    const policies: DeliveryQualityPolicy[] = policiesRes.rows.map((row) => ({
      id: row.id,
      code: row.code,
      version: row.version,
      rules: row.rules,
      rules_sha256: row.rules_sha256,
      signature_reference: row.signature_reference,
      signed_at: row.signed_at,
    }))

    const targetsRes = await db.query<TargetRow>(
      `
        SELECT
          'ALLOCATION:' || a.id::text AS target_key,
          a.id::text AS allocation_id,
          bl.id::text AS delivery_line_id,
          CASE WHEN a.lot_id IS NOT NULL THEN 'LOT' ELSE 'DELIVERY_LINE' END AS object_type,
          COALESCE(a.lot_id::text, bl.id::text) AS object_id,
          CASE WHEN a.lot_id IS NOT NULL THEN l.lot_code ELSE 'Ligne ' || bl.ordre::text END AS label,
          a.quantite::text AS qty_requested,
          a.unite,
          CASE WHEN a.lot_id IS NOT NULL THEN l.lot_status::text ELSE NULL END AS lot_status,
          a.article_id::text AS article_id,
          article.code AS article_code,
          article.designation AS article_designation,
          a.lot_id::text AS lot_id,
          l.lot_code AS lot_code,
          b.commande_id::text AS commande_id,
          applicable_plan.id::text AS plan_id,
          applicable_plan.code AS plan_code,
          applicable_plan.version AS plan_version
        FROM public.bon_livraison b
        JOIN public.bon_livraison_ligne bl ON bl.bon_livraison_id = b.id
        JOIN public.bon_livraison_ligne_allocations a ON a.bon_livraison_ligne_id = bl.id
        LEFT JOIN public.lots l ON l.id = a.lot_id
        LEFT JOIN public.articles article ON article.id = a.article_id
        LEFT JOIN public.pieces_techniques piece ON piece.id = article.piece_technique_id
        LEFT JOIN LATERAL (
          SELECT p.id, p.code, p.version
          FROM public.quality_control_plan p
          WHERE p.status = 'PUBLISHED'
            AND p.trigger_type = 'LOT_RELEASE'
            AND (p.article_id IS NULL OR p.article_id = a.article_id)
            AND (p.piece_technique_id IS NULL OR p.piece_technique_id = article.piece_technique_id)
            AND (p.famille_id IS NULL OR p.famille_id = piece.famille_id)
            AND p.piece_version_id IS NULL
            AND p.operation_code IS NULL
            AND p.fournisseur_id IS NULL
            AND (p.effective_from IS NULL OR p.effective_from <= clock_timestamp())
            AND (p.effective_to IS NULL OR p.effective_to >= clock_timestamp())
          ORDER BY
            ((p.article_id IS NOT NULL)::int * 8 +
             (p.piece_technique_id IS NOT NULL)::int * 4 +
             (p.famille_id IS NOT NULL)::int * 2) DESC,
            p.version DESC,
            p.id
          LIMIT 1
        ) applicable_plan ON true
        WHERE b.id = $1::uuid
        ORDER BY bl.ordre, a.id
      `,
      [bonLivraisonId]
    )

    const targetRows = targetsRes.rows
    const allocationIds = targetRows.map((row) => row.allocation_id)

    const controlsRes =
      targetRows.length === 0
        ? { rows: [] as ControlRow[] }
        : await db.query<ControlRow>(
            `
              SELECT qc.id::text AS id, qc.delivery_allocation_id::text AS delivery_allocation_id,
                     qc.source_type, qc.source_id,
                     qc.qty_released::text, qc.qty_held::text, qc.qty_consumed::text,
                     (qc.validation_date IS NULL OR COALESCE(qc.verdict, 'EN_ATTENTE') = 'EN_ATTENTE') AS pending
              FROM public.quality_control qc
              WHERE qc.delivery_allocation_id = ANY($1::uuid[])
                AND qc.trigger_type = 'LOT_RELEASE'
              ORDER BY qc.delivery_allocation_id, qc.control_date DESC, qc.id DESC
            `,
            [allocationIds]
          )

    const controlsByTarget = new Map<string, ControlRow[]>()
    const targetKeyByControl = new Map<string, string>()
    const targetKeysByControl = new Map<string, string[]>()
    for (const row of controlsRes.rows) {
      if (!row.delivery_allocation_id) continue
      const key = `ALLOCATION:${row.delivery_allocation_id}`
      const values = controlsByTarget.get(key) ?? []
      values.push(row)
      controlsByTarget.set(key, values)
      targetKeysByControl.set(row.id, [key])
      targetKeyByControl.set(row.id, key)
    }

    const ncRes = await db.query<NcRow>(
      `
        SELECT nc.id::text AS id, nc.control_id::text AS control_id,
               nc.lot_id::text AS lot_id, nc.bon_livraison_id::text AS bon_livraison_id,
               (
                 nc.status::text NOT IN ('CLOSED', 'CANCELLED')
                 AND NOT EXISTS (
                   SELECT 1 FROM public.non_conformity_dispositions d
                   WHERE d.non_conformity_id = nc.id
                 )
               ) AS open_without_disposition
        FROM public.non_conformity nc
        WHERE nc.bon_livraison_id = $1::uuid
           OR nc.lot_id = ANY($2::uuid[])
           OR nc.control_id = ANY($3::uuid[])
        ORDER BY nc.id
      `,
      [
        bonLivraisonId,
        targetRows.filter((row) => row.lot_id).map((row) => row.lot_id as string),
        controlsRes.rows.map((row) => row.id),
      ]
    )

    const releaseRes =
      targetRows.length === 0
        ? { rows: [] as ReleaseRow[] }
        : controlsRes.rows.length === 0
          ? { rows: [] as ReleaseRow[] }
          : await db.query<ReleaseRow>(
            `
              SELECT rd.id::text AS id, rd.quality_control_id::text AS quality_control_id,
                     rd.decision, rd.qty::text AS qty, rd.object_type, rd.object_id,
                     rd.derogation_id::text AS derogation_id, rd.justification,
                     rd.decided_at::text AS decided_at,
                     d.code AS d_code, d.status AS d_status,
                     d.article_id::text AS d_article_id,
                     d.piece_technique_id::text AS d_piece_technique_id,
                     d.piece_version_id::text AS d_piece_version_id,
                     d.lot_id::text AS d_lot_id, d.of_id::text AS d_of_id,
                     d.commande_id::text AS d_commande_id,
                     d.bon_livraison_id::text AS d_bon_livraison_id,
                     d.max_qty::text AS d_max_qty, d.unite AS d_unite,
                     d.consumed_qty::text AS d_consumed_qty,
                     d.valid_from::text AS d_valid_from, d.valid_to::text AS d_valid_to,
                     d.requested_by AS d_requested_by, d.requested_at::text AS d_requested_at,
                     d.approved_by AS d_approved_by, d.approved_at::text AS d_approved_at,
                     d.requirement AS d_requirement, d.deviation AS d_deviation,
                     dc.id::text AS consumption_id,
                     dc.bon_livraison_id::text AS consumption_bon_livraison_id,
                     dc.qty::text AS consumption_qty
              FROM public.quality_release_decision rd
              LEFT JOIN public.quality_derogation d ON d.id = rd.derogation_id
              LEFT JOIN public.quality_derogation_consumption dc
                ON dc.derogation_id = d.id
               AND dc.release_decision_id = rd.id
               AND dc.bon_livraison_id = $2::uuid
              WHERE rd.quality_control_id = ANY($1::uuid[])
              ORDER BY rd.quality_control_id, rd.decided_at DESC, rd.id DESC
            `,
            [controlsRes.rows.map((row) => row.id), bonLivraisonId]
          )

    const latestReleaseByTarget = new Map<string, ReleaseRow>()
    const targetKeysByRelease = new Map<string, string[]>()
    const targetKeysByDerogation = new Map<string, string[]>()
    for (const row of releaseRes.rows) {
      const key = targetKeyByControl.get(row.quality_control_id)
      if (!key) continue
      targetKeysByRelease.set(row.id, [key])
      if (row.derogation_id) {
        const keys = targetKeysByDerogation.get(row.derogation_id) ?? []
        if (!keys.includes(key)) keys.push(key)
        targetKeysByDerogation.set(row.derogation_id, keys)
      }
      if (
        !latestReleaseByTarget.has(key) &&
        controlsByTarget.get(key)?.[0]?.id === row.quality_control_id
      ) latestReleaseByTarget.set(key, row)
    }

    const observations: DeliveryQualityTargetObservation[] = targetRows.map((row) => {
      const controls = controlsByTarget.get(row.target_key) ?? []
      const effectiveControl = controls[0] ?? null
      const openNc = ncRes.rows.filter((nc) => {
        if (!nc.open_without_disposition) return false
        if (nc.bon_livraison_id === bonLivraisonId && !nc.lot_id && !nc.control_id) return true
        if (row.lot_id && nc.lot_id === row.lot_id) return true
        return nc.control_id !== null && controls.some((control) => control.id === nc.control_id)
      }).length
      const release = latestReleaseByTarget.get(row.target_key) ?? null

      let derogation: DeliveryQualityDerogation | null = null
      if (release?.derogation_id && release.d_code && release.d_status && release.d_requested_by && release.d_requested_at) {
        derogation = {
          release_decision_id: release.id,
          release_decision_justification: release.justification,
          consumption_id: release.consumption_id,
          consumption_bon_livraison_id: release.consumption_bon_livraison_id,
          consumption_qty: release.consumption_qty === null ? null : toNumber(release.consumption_qty),
          state: {
            id: release.derogation_id,
            code: release.d_code,
            status: release.d_status,
            article_id: release.d_article_id,
            piece_technique_id: release.d_piece_technique_id,
            piece_version_id: release.d_piece_version_id,
            lot_id: release.d_lot_id,
            of_id: release.d_of_id,
            commande_id: release.d_commande_id,
            bon_livraison_id: release.d_bon_livraison_id,
            max_qty: release.d_max_qty === null ? null : toNumber(release.d_max_qty),
            unit: release.d_unite,
            consumed_qty: toNumber(release.d_consumed_qty),
            valid_from: release.d_valid_from,
            valid_to: release.d_valid_to,
          },
          context: {
            article_id: row.article_id,
            piece_technique_id: null,
            piece_version_id: null,
            lot_id: row.lot_id,
            of_id: null,
            commande_id: row.commande_id,
            bon_livraison_id: bonLivraisonId,
            unit: row.unite,
          },
          requested_by: release.d_requested_by,
          requested_at: release.d_requested_at,
          approved_by: release.d_approved_by,
          approved_at: release.d_approved_at,
          requirement: release.d_requirement ?? "",
          deviation: release.d_deviation ?? "",
        }
      }

      return {
        key: row.target_key,
        allocation_id: row.allocation_id,
        delivery_line_id: row.delivery_line_id,
        article_id: row.article_id,
        article_code: row.article_code,
        article_designation: row.article_designation,
        lot_id: row.lot_id,
        lot_code: row.lot_code,
        unite: row.unite,
        plan: row.plan_id && row.plan_code && row.plan_version
          ? { id: row.plan_id, code: row.plan_code, version: row.plan_version }
          : null,
        control_count: controls.length,
        latest_decision: release
          ? {
              id: release.id,
              decision: release.decision,
              qty: toNumber(release.qty),
              decided_at: release.decided_at,
            }
          : null,
        target: {
          object_type: row.object_type,
          object_id: row.object_id,
          label: row.label,
          qty_requested: toNumber(row.qty_requested),
          lot_status: row.lot_status,
          qty_released: effectiveControl ? toNumber(effectiveControl.qty_released) : 0,
          qty_held: effectiveControl ? toNumber(effectiveControl.qty_held) : 0,
          qty_consumed: effectiveControl ? toNumber(effectiveControl.qty_consumed) : 0,
          open_nc_without_disposition: openNc,
          pending_mandatory_controls: effectiveControl?.pending ? 1 : 0,
          derogation: derogation ? { status: derogation.state.status, valid_to: derogation.state.valid_to } : null,
        },
        derogation,
      }
    })

    const controlIds = controlsRes.rows.map((row) => row.id)
    const releaseIds = releaseRes.rows.map((row) => row.id)
    const derogationIds = [...new Set(releaseRes.rows.map((row) => row.derogation_id).filter((id): id is string => Boolean(id)))]
    const evidenceRes =
      controlIds.length + releaseIds.length + derogationIds.length === 0
        ? { rows: [] as EvidenceRow[] }
        : await db.query<EvidenceRow>(
            `
              SELECT qd.id::text AS id, qd.entity_type::text AS entity_type,
                     qd.entity_id::text AS entity_id, qd.document_type::text AS document_type,
                     qd.version, qd.revision, qd.original_name, qd.mime_type,
                     qd.size_bytes::text AS size_bytes, qd.sha256
              FROM public.quality_documents qd
              WHERE qd.removed_at IS NULL
                AND qd.decision_evidence = true
                AND qd.confidentiality = 'CUSTOMER_VISIBLE'
                AND qd.sha256 ~ '^[A-Fa-f0-9]{64}$'
                AND (
                  (qd.entity_type = 'CONTROL' AND qd.entity_id = ANY($1::uuid[]))
                  OR (qd.entity_type = 'RELEASE' AND qd.entity_id = ANY($2::uuid[]))
                  OR (qd.entity_type = 'DEROGATION' AND qd.entity_id = ANY($3::uuid[]))
                )
              ORDER BY qd.id
            `,
            [controlIds, releaseIds, derogationIds]
          )

    const evidence: DeliveryQualityEvidence[] = evidenceRes.rows.map((row) => {
      const keys =
        row.entity_type === "CONTROL"
          ? targetKeysByControl.get(row.entity_id) ?? []
          : row.entity_type === "RELEASE"
            ? targetKeysByRelease.get(row.entity_id) ?? []
            : row.entity_type === "DEROGATION"
              ? targetKeysByDerogation.get(row.entity_id) ?? []
              : []
      return {
        id: row.id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        document_type: row.document_type,
        version: row.version,
        revision: row.revision,
        original_name: row.original_name,
        mime_type: row.mime_type,
        size_bytes: toNumber(row.size_bytes),
        sha256: row.sha256.toLowerCase(),
        target_keys: [...keys].sort(),
      }
    })

    return evaluateDeliveryQualityRelease({
      bon_livraison_id: bonLivraisonId,
      evaluated_at: evaluatedAt,
      policy_candidates: policies,
      targets: observations,
      evidence,
    })
  } catch (error) {
    if (FAIL_CLOSED_SCHEMA_CODES.has(pgCode(error) ?? "")) {
      return unknownRelease(
        bonLivraisonId,
        "Le référentiel nécessaire à la décision Qualité est indisponible ou incomplet."
      )
    }
    throw error
  }
}
