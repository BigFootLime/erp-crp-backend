import pool from "../../../config/database"

import type {
  TraceabilityEdge,
  TraceabilityNode,
  TraceabilityNodeRef,
  TraceabilityNodeType,
} from "../types/traceability.types"

function nodeId(ref: TraceabilityNodeRef): string {
  return `${ref.type}:${ref.id}`
}

function isUuidString(value: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(value)
}

type Neighbor = { ref: TraceabilityNodeRef; relation: string; meta?: Record<string, unknown> | null }

export async function repoListTraceabilityLinks(ref: TraceabilityNodeRef): Promise<Neighbor[]> {
  const res = await pool.query<{
    source_type: string
    source_id: string
    target_type: string
    target_id: string
    link_type: string
    meta: unknown
  }>(
    `
      SELECT
        source_type,
        source_id,
        target_type,
        target_id,
        link_type,
        meta
      FROM public.traceability_links
      WHERE (source_type = $1 AND source_id = $2)
         OR (target_type = $1 AND target_id = $2)
      ORDER BY created_at DESC, id DESC
      LIMIT 500
    `,
    [ref.type, ref.id]
  )

  const out: Neighbor[] = []
  for (const r of res.rows) {
    const isFromSource = r.source_type === ref.type && r.source_id === ref.id
    const other: TraceabilityNodeRef = isFromSource
      ? { type: r.target_type as TraceabilityNodeType, id: r.target_id }
      : { type: r.source_type as TraceabilityNodeType, id: r.source_id }
    const relation = `link:${r.link_type}`
    const meta = r.meta && typeof r.meta === "object" ? (r.meta as Record<string, unknown>) : null
    out.push({ ref: other, relation, meta })
  }
  return out
}

export async function repoListHardNeighbors(ref: TraceabilityNodeRef): Promise<Neighbor[]> {
  switch (ref.type) {
    case "devis": {
      const devisId = Number(ref.id)
      if (!Number.isFinite(devisId)) return []
      const res = await pool.query<{ commande_id: string | null; affaire_id: string | null }>(
        `
          SELECT
            cc.id::text AS commande_id,
            a.id::text AS affaire_id
          FROM devis d
          LEFT JOIN commande_client cc ON cc.devis_id = d.id
          LEFT JOIN affaire a ON a.devis_id = d.id
          WHERE d.id = $1
        `,
        [devisId]
      )
      const row = res.rows[0] ?? null
      const out: Neighbor[] = []
      if (row?.commande_id) out.push({ ref: { type: "commande", id: row.commande_id }, relation: "devis->commande" })
      if (row?.affaire_id) out.push({ ref: { type: "affaire", id: row.affaire_id }, relation: "devis->affaire" })
      return out
    }

    case "commande": {
      const commandeId = Number(ref.id)
      if (!Number.isFinite(commandeId)) return []
      const out: Neighbor[] = []

      const devisRes = await pool.query<{ devis_id: string | null }>(
        `SELECT devis_id::text AS devis_id FROM commande_client WHERE id = $1 LIMIT 1`,
        [commandeId]
      )
      const devisId = devisRes.rows[0]?.devis_id ?? null
      if (devisId) out.push({ ref: { type: "devis", id: devisId }, relation: "commande->devis" })

      const affairesRes = await pool.query<{ affaire_id: string }>(
        `SELECT affaire_id::text AS affaire_id FROM commande_to_affaire WHERE commande_id = $1 ORDER BY id DESC LIMIT 20`,
        [commandeId]
      )
      for (const r of affairesRes.rows) {
        if (r.affaire_id) out.push({ ref: { type: "affaire", id: r.affaire_id }, relation: "commande->affaire" })
      }

      const blRes = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM bon_livraison WHERE commande_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
        [commandeId]
      )
      for (const r of blRes.rows) {
        out.push({ ref: { type: "bon_livraison", id: r.id }, relation: "commande->bon_livraison" })
      }

      const ofRes = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM ordres_fabrication WHERE commande_id = $1 ORDER BY id DESC LIMIT 50`,
        [commandeId]
      )
      for (const r of ofRes.rows) out.push({ ref: { type: "of", id: r.id }, relation: "commande->of" })

      return out
    }

    case "affaire": {
      const affaireId = Number(ref.id)
      if (!Number.isFinite(affaireId)) return []

      const baseRes = await pool.query<{ commande_id: string | null; devis_id: string | null }>(
        `SELECT commande_id::text AS commande_id, devis_id::text AS devis_id FROM affaire WHERE id = $1 LIMIT 1`,
        [affaireId]
      )
      const base = baseRes.rows[0] ?? null
      const out: Neighbor[] = []
      if (base?.commande_id) out.push({ ref: { type: "commande", id: base.commande_id }, relation: "affaire->commande" })
      if (base?.devis_id) out.push({ ref: { type: "devis", id: base.devis_id }, relation: "affaire->devis" })

      const ofRes = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM ordres_fabrication WHERE affaire_id = $1 ORDER BY id DESC LIMIT 50`,
        [affaireId]
      )
      for (const r of ofRes.rows) out.push({ ref: { type: "of", id: r.id }, relation: "affaire->of" })

      const blRes = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM bon_livraison WHERE affaire_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
        [affaireId]
      )
      for (const r of blRes.rows) out.push({ ref: { type: "bon_livraison", id: r.id }, relation: "affaire->bon_livraison" })

      return out
    }

    case "of": {
      const ofId = Number(ref.id)
      if (!Number.isFinite(ofId)) return []
      const out: Neighbor[] = []

      const baseRes = await pool.query<{ affaire_id: string | null; commande_id: string | null }>(
        `SELECT affaire_id::text AS affaire_id, commande_id::text AS commande_id FROM ordres_fabrication WHERE id = $1 LIMIT 1`,
        [ofId]
      )
      const base = baseRes.rows[0] ?? null
      if (base?.affaire_id) out.push({ ref: { type: "affaire", id: base.affaire_id }, relation: "of->affaire" })
      if (base?.commande_id) out.push({ ref: { type: "commande", id: base.commande_id }, relation: "of->commande" })

      const lotsRes = await pool.query<{ lot_id: string; lot_code: string | null; qty_ok: number }>(
        `
          SELECT ool.lot_id::text AS lot_id, l.lot_code, ool.qty_ok::float8 AS qty_ok
          FROM public.of_output_lots ool
          JOIN public.lots l ON l.id = ool.lot_id
          WHERE ool.of_id = $1
          ORDER BY ool.updated_at DESC, ool.id DESC
          LIMIT 200
        `,
        [ofId]
      )
      for (const r of lotsRes.rows) {
        out.push({
          ref: { type: "lot", id: r.lot_id },
          relation: "of->lot",
          meta: { lot_code: r.lot_code, qty_ok: Number(r.qty_ok) },
        })
      }

      return out
    }

    case "lot": {
      if (!isUuidString(ref.id)) return []
      const out: Neighbor[] = []

      const ofRes = await pool.query<{ of_id: string }>(
        `SELECT of_id::text AS of_id FROM public.of_output_lots WHERE lot_id = $1::uuid ORDER BY updated_at DESC, id DESC LIMIT 50`,
        [ref.id]
      )
      for (const r of ofRes.rows) out.push({ ref: { type: "of", id: r.of_id }, relation: "lot->of" })

      const blRes = await pool.query<{ bon_livraison_id: string }>(
        `
          SELECT bl.id::text AS bon_livraison_id
          FROM public.bon_livraison_ligne_allocations a
          JOIN public.bon_livraison_ligne l ON l.id = a.bon_livraison_ligne_id
          JOIN public.bon_livraison bl ON bl.id = l.bon_livraison_id
          WHERE a.lot_id = $1::uuid
          ORDER BY bl.created_at DESC, bl.id DESC
          LIMIT 100
        `,
        [ref.id]
      )
      for (const r of blRes.rows) out.push({ ref: { type: "bon_livraison", id: r.bon_livraison_id }, relation: "lot->bon_livraison" })

      const ncRes = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM public.non_conformity WHERE lot_id = $1::uuid ORDER BY detection_date DESC, id DESC LIMIT 100`,
        [ref.id]
      )
      for (const r of ncRes.rows) out.push({ ref: { type: "non_conformity", id: r.id }, relation: "lot->non_conformity" })

      return out
    }

    case "bon_livraison": {
      if (!isUuidString(ref.id)) return []
      const out: Neighbor[] = []

      const baseRes = await pool.query<{ commande_id: string | null; affaire_id: string | null }>(
        `SELECT commande_id::text AS commande_id, affaire_id::text AS affaire_id FROM bon_livraison WHERE id = $1::uuid LIMIT 1`,
        [ref.id]
      )
      const base = baseRes.rows[0] ?? null
      if (base?.commande_id) out.push({ ref: { type: "commande", id: base.commande_id }, relation: "bon_livraison->commande" })
      if (base?.affaire_id) out.push({ ref: { type: "affaire", id: base.affaire_id }, relation: "bon_livraison->affaire" })

      const lotsRes = await pool.query<{ lot_id: string }>(
        `
          SELECT DISTINCT a.lot_id::text AS lot_id
          FROM public.bon_livraison_ligne_allocations a
          JOIN public.bon_livraison_ligne l ON l.id = a.bon_livraison_ligne_id
          WHERE l.bon_livraison_id = $1::uuid
            AND a.lot_id IS NOT NULL
          ORDER BY a.lot_id ASC
          LIMIT 200
        `,
        [ref.id]
      )
      for (const r of lotsRes.rows) out.push({ ref: { type: "lot", id: r.lot_id }, relation: "bon_livraison->lot" })

      return out
    }

    case "non_conformity": {
      if (!isUuidString(ref.id)) return []
      const res = await pool.query<{ lot_id: string | null; of_id: string | null; affaire_id: string | null }>(
        `SELECT lot_id::text AS lot_id, of_id::text AS of_id, affaire_id::text AS affaire_id FROM public.non_conformity WHERE id = $1::uuid LIMIT 1`,
        [ref.id]
      )
      const row = res.rows[0] ?? null
      const out: Neighbor[] = []
      if (row?.lot_id) out.push({ ref: { type: "lot", id: row.lot_id }, relation: "non_conformity->lot" })
      if (row?.of_id) out.push({ ref: { type: "of", id: row.of_id }, relation: "non_conformity->of" })
      if (row?.affaire_id) out.push({ ref: { type: "affaire", id: row.affaire_id }, relation: "non_conformity->affaire" })
      return out
    }

    default:
      return []
  }
}

export async function repoHydrateNodes(refs: TraceabilityNodeRef[]): Promise<Map<string, TraceabilityNode>> {
  const byType = new Map<TraceabilityNodeType, TraceabilityNodeRef[]>()
  for (const r of refs) {
    const arr = byType.get(r.type) ?? []
    arr.push(r)
    byType.set(r.type, arr)
  }

  const out = new Map<string, TraceabilityNode>()

  const add = (ref: TraceabilityNodeRef, label: string, meta: Record<string, unknown> | null) => {
    out.set(nodeId(ref), {
      node_id: nodeId(ref),
      type: ref.type,
      id: ref.id,
      label,
      meta,
    })
  }

  const devisRefs = byType.get("devis") ?? []
  if (devisRefs.length) {
    const ids = devisRefs.map((r) => Number(r.id)).filter((n) => Number.isFinite(n))
    if (ids.length) {
      const res = await pool.query<{ id: string; numero: string; statut: string; date_creation: string | null }>(
        `SELECT id::text AS id, numero, statut, date_creation::text AS date_creation FROM devis WHERE id = ANY($1::bigint[])`,
        [ids]
      )
      for (const r of res.rows) {
        add({ type: "devis", id: r.id }, `Devis ${r.numero}`, { statut: r.statut, date_creation: r.date_creation })
      }
    }
  }

  const cmdRefs = byType.get("commande") ?? []
  if (cmdRefs.length) {
    const ids = cmdRefs.map((r) => Number(r.id)).filter((n) => Number.isFinite(n))
    if (ids.length) {
      const res = await pool.query<{ id: string; numero: string; date_commande: string | null; statut: string }>(
        `
          SELECT
            cc.id::text AS id,
            cc.numero,
            cc.date_commande::text AS date_commande,
            COALESCE(st.nouveau_statut, 'brouillon') AS statut
          FROM commande_client cc
          LEFT JOIN LATERAL (
            SELECT ch.nouveau_statut
            FROM commande_historique ch
            WHERE ch.commande_id = cc.id
            ORDER BY ch.date_action DESC, ch.id DESC
            LIMIT 1
          ) st ON TRUE
          WHERE cc.id = ANY($1::bigint[])
        `,
        [ids]
      )
      for (const r of res.rows) {
        add({ type: "commande", id: r.id }, `Commande ${r.numero}`, { statut: r.statut, date_commande: r.date_commande })
      }
    }
  }

  const affaireRefs = byType.get("affaire") ?? []
  if (affaireRefs.length) {
    const ids = affaireRefs.map((r) => Number(r.id)).filter((n) => Number.isFinite(n))
    if (ids.length) {
      const res = await pool.query<{ id: string; reference: string; statut: string; type_affaire: string; date_ouverture: string | null }>(
        `
          SELECT id::text AS id, reference, statut, type_affaire, date_ouverture::text AS date_ouverture
          FROM affaire
          WHERE id = ANY($1::bigint[])
        `,
        [ids]
      )
      for (const r of res.rows) {
        add({ type: "affaire", id: r.id }, `Affaire ${r.reference}`, {
          statut: r.statut,
          type_affaire: r.type_affaire,
          date_ouverture: r.date_ouverture,
        })
      }
    }
  }

  const ofRefs = byType.get("of") ?? []
  if (ofRefs.length) {
    const ids = ofRefs.map((r) => Number(r.id)).filter((n) => Number.isFinite(n))
    if (ids.length) {
      const res = await pool.query<{ id: string; numero: string; statut: string; priority: string | null }>(
        `SELECT id::text AS id, numero, statut::text AS statut, priority::text AS priority FROM ordres_fabrication WHERE id = ANY($1::bigint[])`,
        [ids]
      )
      for (const r of res.rows) {
        add({ type: "of", id: r.id }, `OF ${r.numero}`, { statut: r.statut, priority: r.priority })
      }
    }
  }

  const lotRefs = byType.get("lot") ?? []
  if (lotRefs.length) {
    const ids = lotRefs.map((r) => r.id).filter(isUuidString)
    if (ids.length) {
      const res = await pool.query<{ id: string; lot_code: string; article_code: string; article_designation: string }>(
        `
          SELECT
            l.id::text AS id,
            l.lot_code,
            a.code AS article_code,
            a.designation AS article_designation
          FROM public.lots l
          JOIN public.articles a ON a.id = l.article_id
          WHERE l.id = ANY($1::uuid[])
        `,
        [ids]
      )
      for (const r of res.rows) {
        add({ type: "lot", id: r.id }, `Lot ${r.lot_code}`, {
          lot_code: r.lot_code,
          article_code: r.article_code,
          article_designation: r.article_designation,
        })
      }
    }
  }

  const blRefs = byType.get("bon_livraison") ?? []
  if (blRefs.length) {
    const ids = blRefs.map((r) => r.id).filter(isUuidString)
    if (ids.length) {
      const res = await pool.query<{ id: string; numero: string; statut: string; reception_date_signature: string | null }>(
        `SELECT id::text AS id, numero, statut, reception_date_signature::text AS reception_date_signature FROM bon_livraison WHERE id = ANY($1::uuid[])`,
        [ids]
      )
      for (const r of res.rows) {
        add({ type: "bon_livraison", id: r.id }, `BL ${r.numero}`, {
          statut: r.statut,
          reception_date_signature: r.reception_date_signature,
        })
      }
    }
  }

  const ncRefs = byType.get("non_conformity") ?? []
  if (ncRefs.length) {
    const ids = ncRefs.map((r) => r.id).filter(isUuidString)
    if (ids.length) {
      const res = await pool.query<{ id: string; reference: string; status: string; severity: string; due_date: string | null }>(
        `SELECT id::text AS id, reference, status::text AS status, severity::text AS severity, due_date::text AS due_date FROM public.non_conformity WHERE id = ANY($1::uuid[])`,
        [ids]
      )
      for (const r of res.rows) {
        add({ type: "non_conformity", id: r.id }, `NC ${r.reference}`, {
          status: r.status,
          severity: r.severity,
          due_date: r.due_date,
        })
      }
    }
  }

  for (const ref of refs) {
    const key = nodeId(ref)
    if (!out.has(key)) add(ref, `${ref.type}:${ref.id}`, null)
  }

  return out
}

export async function repoComputeHighlights(
  refs: TraceabilityNodeRef[]
): Promise<Array<{ node_id: string; code: string; level: "info" | "warning" | "danger"; message: string }>> {
  const lotIds = refs.filter((r) => r.type === "lot" && isUuidString(r.id)).map((r) => r.id)
  if (lotIds.length === 0) return []

  const res = await pool.query<{ lot_id: string; open_total: number; overdue_total: number }>(
    `
      SELECT
        nc.lot_id::text AS lot_id,
        COUNT(*) FILTER (WHERE nc.status <> 'CLOSED')::int AS open_total,
        COUNT(*) FILTER (WHERE nc.status <> 'CLOSED' AND nc.due_date IS NOT NULL AND nc.due_date < CURRENT_DATE)::int AS overdue_total
      FROM public.non_conformity nc
      WHERE nc.lot_id = ANY($1::uuid[])
      GROUP BY nc.lot_id
    `,
    [lotIds]
  )

  const out: Array<{ node_id: string; code: string; level: "info" | "warning" | "danger"; message: string }> = []
  for (const r of res.rows) {
    const nid = `lot:${r.lot_id}`
    if (r.overdue_total > 0) {
      out.push({ node_id: nid, code: "NC_OVERDUE", level: "danger", message: `${r.overdue_total} non-conformite(s) en retard` })
    } else if (r.open_total > 0) {
      out.push({ node_id: nid, code: "NC_OPEN", level: "warning", message: `${r.open_total} non-conformite(s) ouverte(s)` })
    }
  }

  return out
}

export function makeEdge(params: {
  source: TraceabilityNodeRef
  target: TraceabilityNodeRef
  relation: string
  meta?: Record<string, unknown> | null
}): TraceabilityEdge {
  const src = nodeId(params.source)
  const tgt = nodeId(params.target)
  const edgeId = `${src}=>${tgt}#${params.relation}`
  return {
    edge_id: edgeId,
    source: src,
    target: tgt,
    relation: params.relation,
    meta: params.meta ?? null,
  }
}
