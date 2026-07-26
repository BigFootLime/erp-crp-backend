// Traçabilité industrielle 360 (#142) — hydratation BATCHÉE des nœuds.
//
// Une requête par type de nœud présent dans le graphe, jamais une par nœud.
// Chaque nœud sort avec un CODE MÉTIER lisible : l'opérateur ne doit jamais
// avoir à lire un UUID pour comprendre ce qu'il regarde. L'identifiant interne
// reste présent pour la navigation technique, il n'est pas l'identité.
//
// Aucune de ces requêtes ne sélectionne `storage_path`, `file_path`,
// `stored_name` ni aucun chemin serveur : un chemin de stockage n'est pas une
// donnée métier et n'a rien à faire dans un DTO public.

import pool from "../../../config/database";

import {
  NODE_TYPE_FAMILY,
  NODE_TYPE_LABELS,
  authoritativeRoute,
  isBigintId,
  isUuid,
  nodeKey,
  type TraceabilityNodeRef,
  type TraceabilityNodeType,
} from "../domain/traceability-model";
import {
  maskOperatorLabel,
  nodeTypeIsVisible,
  type TraceabilityCapabilitySet,
} from "../domain/traceability-policy";

export type TraceabilityNodeDTO = {
  node_id: string;
  type: TraceabilityNodeType;
  type_label: string;
  family: string;
  /** Identifiant interne, opaque, utilisé pour la navigation technique. */
  id: string;
  /** Code métier visible : c'est CE qui identifie l'objet pour un humain. */
  code: string;
  label: string;
  /** Statut ACTUEL de l'objet (≠ statut au moment de la relation). */
  status: string | null;
  date: string | null;
  qty: number | null;
  unit: string | null;
  route: string | null;
  /** `true` si le nœud porte une donnée personnelle masquée pour cet appelant. */
  masked: boolean;
  meta: Record<string, unknown> | null;
};

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

async function safeQuery(sql: string, params: unknown[]): Promise<Row[]> {
  try {
    const res = await pool.query(sql, params);
    return (res?.rows ?? []) as Row[];
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "42P01" || code === "42501" || code === "42703") return [];
    throw err;
  }
}

type HydrateQuery = {
  sql: string;
  cast: "uuid" | "bigint" | "text";
};

/**
 * Une entrée par type. `id`, `code`, `label`, `status`, `date` sont le contrat
 * commun ; `qty`, `unit` et `meta_*` sont optionnels.
 */
const QUERIES: Partial<Record<TraceabilityNodeType, HydrateQuery>> = {
  lot: {
    cast: "uuid",
    sql: `SELECT l.id::text AS id, l.lot_code AS code,
                 (l.lot_code || ' — ' || COALESCE(a.designation, a.code, '')) AS label,
                 l.lot_status AS status,
                 COALESCE(l.manufactured_at::text, l.received_at::text, l.created_at::text) AS date,
                 NULL::float8 AS qty, a.unite AS unit,
                 a.code AS meta_article_code, a.designation AS meta_article_designation,
                 l.supplier_lot_code AS meta_supplier_lot_code
            FROM public.lots l
            LEFT JOIN public.articles a ON a.id = l.article_id
           WHERE l.id = ANY($1::uuid[])`,
  },
  article: {
    cast: "uuid",
    sql: `SELECT a.id::text AS id, a.code AS code,
                 (a.code || ' — ' || COALESCE(a.designation, '')) AS label,
                 a.status AS status, a.updated_at::text AS date,
                 NULL::float8 AS qty, a.unite AS unit,
                 a.article_type AS meta_article_type, a.article_category AS meta_article_category
            FROM public.articles a
           WHERE a.id = ANY($1::uuid[])`,
  },
  piece_technique: {
    cast: "uuid",
    sql: `SELECT p.id::text AS id, p.code_piece AS code,
                 (COALESCE(p.code_piece, '') || ' — ' || COALESCE(p.designation, '')) AS label,
                 p.statut AS status, p.updated_at::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 p.ensemble::text AS meta_ensemble
            FROM public.pieces_techniques p
           WHERE p.id = ANY($1::uuid[])`,
  },
  piece_version: {
    cast: "uuid",
    sql: `SELECT v.id::text AS id, COALESCE(v.code_metier, v.indice) AS code,
                 ('Indice ' || COALESCE(v.indice, '?') || COALESCE(' — plan ' || v.plan_reference, '')) AS label,
                 v.statut AS status, COALESCE(v.date_effet::text, v.created_at::text) AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 v.plan_reference AS meta_plan_reference, v.is_current::text AS meta_is_current
            FROM public.piece_technique_versions v
           WHERE v.id = ANY($1::uuid[])`,
  },
  of: {
    cast: "bigint",
    sql: `SELECT o.id::text AS id, o.numero AS code,
                 ('OF ' || o.numero) AS label,
                 o.statut::text AS status,
                 COALESCE(o.date_lancement_reelle::text, o.date_lancement_prevue::text, o.created_at::text) AS date,
                 o.quantite_lancee::float8 AS qty, NULL::text AS unit,
                 o.generation_level::text AS meta_level, o.structure_path AS meta_structure_path,
                 o.technical_snapshot_sha256 AS meta_snapshot_sha256,
                 o.parent_of_id::text AS meta_parent_of_id, o.root_of_id::text AS meta_root_of_id,
                 o.quantite_bonne::float8 AS meta_qty_ok, o.quantite_rebut::float8 AS meta_qty_scrap
            FROM public.ordres_fabrication o
           WHERE o.id = ANY($1::bigint[])`,
  },
  of_operation: {
    cast: "uuid",
    sql: `SELECT op.id::text AS id, ('PH' || LPAD(op.phase::text, 2, '0')) AS code,
                 ('PH' || LPAD(op.phase::text, 2, '0') || ' — ' || COALESCE(op.designation, '')) AS label,
                 op.status::text AS status,
                 COALESCE(op.ended_at::text, op.started_at::text, op.created_at::text) AS date,
                 op.qte::float8 AS qty, NULL::text AS unit,
                 op.temps_total_planned::text AS meta_temps_planned,
                 op.temps_total_real::text AS meta_temps_real
            FROM public.of_operations op
           WHERE op.id = ANY($1::uuid[])`,
  },
  pointage: {
    cast: "uuid",
    sql: `SELECT p.id::text AS id, ('PT-' || SUBSTRING(p.id::text, 1, 8)) AS code,
                 (COALESCE(p.time_type::text, 'POINTAGE')) AS label,
                 p.status::text AS status, p.start_ts::text AS date,
                 p.duration_minutes::float8 AS qty, 'min'::text AS unit,
                 p.operator_user_id::text AS meta_operator_user_id,
                 NULLIF(TRIM(COALESCE(u.name, '') || ' ' || COALESCE(u.surname, '')), '') AS meta_operator_label
            FROM public.production_pointages p
            LEFT JOIN public.users u ON u.id = p.operator_user_id
           WHERE p.id = ANY($1::uuid[])`,
  },
  machine: {
    cast: "uuid",
    sql: `SELECT m.id::text AS id, m.code AS code,
                 COALESCE(m.display_name, m.name, m.code) AS label,
                 m.status AS status, m.updated_at::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 m.workshop_zone AS meta_zone
            FROM public.machines m
           WHERE m.id = ANY($1::uuid[])`,
  },
  poste: {
    cast: "uuid",
    sql: `SELECT p.id::text AS id, p.code AS code, COALESCE(p.label, p.code) AS label,
                 CASE WHEN p.is_active THEN 'ACTIF' ELSE 'INACTIF' END AS status,
                 p.updated_at::text AS date, NULL::float8 AS qty, NULL::text AS unit
            FROM public.postes p
           WHERE p.id = ANY($1::uuid[])`,
  },
  of_receipt: {
    cast: "uuid",
    sql: `SELECT r.id::text AS id, ('REC-' || SUBSTRING(r.id::text, 1, 8)) AS code,
                 'Réception de production' AS label,
                 r.quality_status AS status, r.created_at::text AS date,
                 r.qty_ok::float8 AS qty, NULL::text AS unit,
                 r.qty_scrap::float8 AS meta_qty_scrap, r.qty_rework::float8 AS meta_qty_rework
            FROM public.of_receipts r
           WHERE r.id = ANY($1::uuid[])`,
  },
  material_consumption: {
    cast: "uuid",
    sql: `SELECT c.id::text AS id, ('CONS-' || SUBSTRING(c.id::text, 1, 8)) AS code,
                 'Consommation matière' AS label, c.status AS status,
                 c.effective_at::text AS date, c.qty::float8 AS qty, c.unit_code AS unit
            FROM public.of_material_consumptions c
           WHERE c.id = ANY($1::uuid[])`,
  },
  stock_movement: {
    cast: "uuid",
    sql: `SELECT m.id::text AS id, COALESCE(m.movement_no, 'MVT-' || SUBSTRING(m.id::text, 1, 8)) AS code,
                 (m.movement_type::text || ' ' || COALESCE(m.movement_no, '')) AS label,
                 m.status AS status,
                 COALESCE(m.posted_at::text, m.effective_at::text) AS date,
                 m.qty::float8 AS qty, NULL::text AS unit,
                 m.movement_type::text AS meta_movement_type,
                 m.source_document_type AS meta_source_document_type,
                 m.reversal_of_id::text AS meta_reversal_of_id,
                 m.reason_code AS meta_reason_code
            FROM public.stock_movements m
           WHERE m.id = ANY($1::uuid[])`,
  },
  reservation: {
    cast: "uuid",
    sql: `SELECT r.id::text AS id, ('RES-' || SUBSTRING(r.id::text, 1, 8)) AS code,
                 ('Réservation ' || COALESCE(r.source_type, '')) AS label,
                 r.status AS status, r.created_at::text AS date,
                 r.qty_reserved::float8 AS qty, NULL::text AS unit,
                 r.source_type AS meta_source_type
            FROM public.stock_reservations r
           WHERE r.id = ANY($1::uuid[])`,
  },
  fournisseur: {
    cast: "uuid",
    sql: `SELECT f.id::text AS id, COALESCE(f.code_fournisseur, f.code) AS code,
                 COALESCE(f.raison_sociale, f.nom, f.code_fournisseur) AS label,
                 COALESCE(f.status, CASE WHEN f.actif THEN 'ACTIF' ELSE 'INACTIF' END) AS status,
                 f.updated_at::text AS date, NULL::float8 AS qty, NULL::text AS unit
            FROM public.fournisseurs f
           WHERE f.id = ANY($1::uuid[])`,
  },
  commande_fournisseur: {
    cast: "uuid",
    sql: `SELECT c.id::text AS id, c.code AS code, ('BCF ' || c.code) AS label,
                 c.statut AS status, c.created_at::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 c.reference_fournisseur AS meta_reference_fournisseur
            FROM public.commande_fournisseur c
           WHERE c.id = ANY($1::uuid[])`,
  },
  reception_fournisseur: {
    cast: "uuid",
    sql: `SELECT r.id::text AS id, r.reception_no AS code,
                 ('Réception ' || r.reception_no) AS label,
                 r.status AS status, r.reception_date::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 r.supplier_reference AS meta_supplier_reference
            FROM public.receptions_fournisseurs r
           WHERE r.id = ANY($1::uuid[])`,
  },
  reception_ligne: {
    cast: "uuid",
    sql: `SELECT rl.id::text AS id,
                 (r.reception_no || '-' || LPAD(rl.line_no::text, 3, '0')) AS code,
                 COALESCE(rl.designation, a.designation, a.code, 'Ligne de réception') AS label,
                 r.status AS status, r.reception_date::text AS date,
                 rl.qty_received::float8 AS qty, rl.unite AS unit,
                 rl.supplier_lot_code AS meta_supplier_lot_code
            FROM public.reception_fournisseur_lignes rl
            JOIN public.receptions_fournisseurs r ON r.id = rl.reception_id
            LEFT JOIN public.articles a ON a.id = rl.article_id
           WHERE rl.id = ANY($1::uuid[])`,
  },
  reception_inspection: {
    cast: "uuid",
    sql: `SELECT i.id::text AS id, ('INSP-' || SUBSTRING(i.id::text, 1, 8)) AS code,
                 'Inspection entrante' AS label, i.status AS status,
                 COALESCE(i.decided_at::text, i.started_at::text) AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 i.decision AS meta_decision
            FROM public.reception_incoming_inspections i
           WHERE i.id = ANY($1::uuid[])`,
  },
  quality_control: {
    cast: "uuid",
    sql: `SELECT qc.id::text AS id, COALESCE(qc.reference, 'CTRL-' || SUBSTRING(qc.id::text, 1, 8)) AS code,
                 ('Contrôle ' || COALESCE(qc.control_type::text, '')) AS label,
                 qc.status::text AS status, qc.control_date::text AS date,
                 qc.qty_controlled::float8 AS qty, qc.unite AS unit,
                 qc.verdict AS meta_verdict, qc.verdict_computed AS meta_verdict_computed,
                 qc.result::text AS meta_result, qc.plan_snapshot_sha256 AS meta_plan_sha256,
                 qc.plan_version::text AS meta_plan_version
            FROM public.quality_control qc
           WHERE qc.id = ANY($1::uuid[])`,
  },
  quality_measurement: {
    cast: "uuid",
    sql: `SELECT p.id::text AS id, COALESCE(p.characteristic_key, p.characteristic) AS code,
                 p.characteristic AS label, p.result::text AS status,
                 COALESCE(p.measured_at::text, p.created_at::text) AS date,
                 p.measured_value::float8 AS qty, p.unit AS unit,
                 p.nominal_value::float8 AS meta_nominal, p.tolerance_min::float8 AS meta_tol_min,
                 p.tolerance_max::float8 AS meta_tol_max, p.criticality AS meta_criticality,
                 p.instrument_id::text AS meta_instrument_id, p.sample_no::text AS meta_sample_no
            FROM public.quality_control_points p
           WHERE p.id = ANY($1::uuid[])`,
  },
  non_conformity: {
    cast: "uuid",
    sql: `SELECT nc.id::text AS id, nc.reference AS code,
                 ('NC ' || nc.reference) AS label, nc.status::text AS status,
                 nc.detection_date::text AS date, nc.qty::float8 AS qty, nc.unite AS unit,
                 nc.severity::text AS meta_severity, nc.due_date::text AS meta_due_date,
                 nc.origin AS meta_origin, nc.confidentiality AS meta_confidentiality
            FROM public.non_conformity nc
           WHERE nc.id = ANY($1::uuid[])`,
  },
  quality_action: {
    cast: "uuid",
    sql: `SELECT a.id::text AS id, COALESCE(a.reference, 'ACT-' || SUBSTRING(a.id::text, 1, 8)) AS code,
                 COALESCE(a.description, a.action_type::text) AS label,
                 a.status::text AS status, a.created_at::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 a.action_type::text AS meta_action_type, a.due_date::text AS meta_due_date
            FROM public.quality_action a
           WHERE a.id = ANY($1::uuid[])`,
  },
  derogation: {
    cast: "uuid",
    sql: `SELECT d.id::text AS id, d.code AS code, ('Dérogation ' || d.code) AS label,
                 d.status AS status, COALESCE(d.approved_at::text, d.requested_at::text) AS date,
                 d.max_qty::float8 AS qty, d.unite AS unit,
                 d.derogation_type AS meta_type, d.consumed_qty::float8 AS meta_consumed_qty,
                 d.valid_to::text AS meta_valid_to
            FROM public.quality_derogation d
           WHERE d.id = ANY($1::uuid[])`,
  },
  release_decision: {
    cast: "uuid",
    sql: `SELECT d.id::text AS id, ('LIB-' || SUBSTRING(d.id::text, 1, 8)) AS code,
                 ('Décision ' || COALESCE(d.decision, '')) AS label,
                 d.decision AS status, d.decided_at::text AS date,
                 d.qty::float8 AS qty, d.unite AS unit,
                 d.verdict AS meta_verdict, d.object_type AS meta_object_type
            FROM public.quality_release_decision d
           WHERE d.id = ANY($1::uuid[])`,
  },
  metrology_equipment: {
    cast: "uuid",
    sql: `SELECT e.id::text AS id, e.code AS code,
                 (e.code || ' — ' || COALESCE(e.designation, '')) AS label,
                 COALESCE(e.etat, e.statut) AS status, e.updated_at::text AS date,
                 NULL::float8 AS qty, e.unite AS unit,
                 e.criticite AS meta_criticite, e.last_conforme_at::text AS meta_last_conforme_at
            FROM public.metrologie_equipements e
           WHERE e.id = ANY($1::uuid[])`,
  },
  metrology_certificate: {
    cast: "uuid",
    sql: `SELECT c.id::text AS id,
                 COALESCE(c.numero_externe, 'CERT-' || SUBSTRING(c.id::text, 1, 8)) AS code,
                 ('Certificat ' || COALESCE(c.document_kind, '')) AS label,
                 COALESCE(c.statut, c.resultat) AS status, c.date_etalonnage::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 c.date_echeance::text AS meta_date_echeance, c.resultat AS meta_resultat,
                 c.sha256 AS meta_sha256, c.organisme AS meta_organisme
            FROM public.metrologie_certificats c
           WHERE c.id = ANY($1::uuid[]) AND c.deleted_at IS NULL`,
  },
  bon_livraison: {
    cast: "uuid",
    sql: `SELECT bl.id::text AS id, bl.numero AS code, ('BL ' || bl.numero) AS label,
                 bl.statut AS status,
                 COALESCE(bl.date_livraison::text, bl.date_expedition::text, bl.date_creation::text) AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 bl.transporteur AS meta_transporteur,
                 bl.reception_date_signature::text AS meta_signature_at
            FROM public.bon_livraison bl
           WHERE bl.id = ANY($1::uuid[])`,
  },
  bon_livraison_ligne: {
    cast: "uuid",
    sql: `SELECT bll.id::text AS id,
                 (bl.numero || '-' || LPAD(bll.ordre::text, 3, '0')) AS code,
                 COALESCE(bll.designation, bll.code_piece, 'Ligne BL') AS label,
                 bl.statut AS status, bl.date_creation::text AS date,
                 bll.quantite::float8 AS qty, bll.unite AS unit,
                 bll.code_piece AS meta_code_piece
            FROM public.bon_livraison_ligne bll
            JOIN public.bon_livraison bl ON bl.id = bll.bon_livraison_id
           WHERE bll.id = ANY($1::uuid[])`,
  },
  delivery_proof: {
    cast: "uuid",
    sql: `SELECT p.id::text AS id, ('PREUVE-' || SUBSTRING(p.id::text, 1, 8)) AS code,
                 ('Preuve ' || COALESCE(p.proof_type, '')) AS label,
                 p.proof_type AS status, p.delivered_at::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 p.received_by_name AS meta_received_by_name
            FROM public.bon_livraison_delivery_proofs p
           WHERE p.id = ANY($1::uuid[])`,
  },
  client: {
    cast: "text",
    sql: `SELECT c.client_id::text AS id, COALESCE(c.client_code, c.client_id) AS code,
                 c.company_name AS label, c.status AS status, c.updated_at::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit
            FROM public.clients c
           WHERE c.client_id = ANY($1::text[])`,
  },
  affaire: {
    cast: "bigint",
    sql: `SELECT a.id::text AS id, a.reference AS code, ('Affaire ' || a.reference) AS label,
                 a.statut AS status, a.date_ouverture::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 a.type_affaire AS meta_type_affaire
            FROM public.affaire a
           WHERE a.id = ANY($1::bigint[])`,
  },
  commande: {
    cast: "bigint",
    sql: `SELECT cc.id::text AS id, cc.numero AS code, ('Commande ' || cc.numero) AS label,
                 cc.order_type AS status, cc.date_commande::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 cc.code_client AS meta_code_client
            FROM public.commande_client cc
           WHERE cc.id = ANY($1::bigint[])`,
  },
  commande_ligne: {
    cast: "bigint",
    sql: `SELECT cl.id::text AS id,
                 (cc.numero || '-' || cl.id::text) AS code,
                 COALESCE(cl.designation, cl.code_piece, 'Ligne de commande') AS label,
                 NULL::text AS status, cc.date_commande::text AS date,
                 cl.quantite::float8 AS qty, cl.unite AS unit,
                 cl.code_piece AS meta_code_piece
            FROM public.commande_ligne cl
            JOIN public.commande_client cc ON cc.id = cl.commande_id
           WHERE cl.id = ANY($1::bigint[])`,
  },
  devis: {
    cast: "bigint",
    sql: `SELECT d.id::text AS id, d.numero AS code, ('Devis ' || d.numero) AS label,
                 d.statut::text AS status, d.date_creation::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit
            FROM public.devis d
           WHERE d.id = ANY($1::bigint[])`,
  },
  asbuilt_pack: {
    cast: "uuid",
    sql: `SELECT p.id::text AS id, ('AS-BUILT v' || p.version::text) AS code,
                 ('Dossier as-built version ' || p.version::text) AS label,
                 p.status AS status, p.generated_at::text AS date,
                 NULL::float8 AS qty, NULL::text AS unit,
                 p.version::text AS meta_version
            FROM public.asbuilt_pack_versions p
           WHERE p.id = ANY($1::uuid[])`,
  },
};

function castIds(type: TraceabilityNodeType, ids: string[], cast: HydrateQuery["cast"]): string[] {
  if (cast === "uuid") return ids.filter(isUuid);
  if (cast === "bigint") return ids.filter(isBigintId);
  return ids.filter((id) => id.length > 0 && id.length <= 64);
}

function collectMeta(row: Row): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("meta_")) continue;
    if (value === null || value === undefined) continue;
    meta[key.slice(5)] = value;
  }
  return Object.keys(meta).length ? meta : null;
}

/**
 * Hydratation batchée. Les nœuds introuvables (supprimés, ou hors périmètre du
 * rôle applicatif) ressortent avec un libellé explicite plutôt qu'avec un
 * UUID nu : « relation orpheline » est une information, pas un bug à cacher.
 */
export async function repoHydrateNodesBatched(
  refs: TraceabilityNodeRef[],
  caps: TraceabilityCapabilitySet
): Promise<Map<string, TraceabilityNodeDTO>> {
  const byType = new Map<TraceabilityNodeType, string[]>();
  for (const ref of refs) {
    const arr = byType.get(ref.type);
    if (arr) arr.push(ref.id);
    else byType.set(ref.type, [ref.id]);
  }

  const out = new Map<string, TraceabilityNodeDTO>();

  const jobs: Array<Promise<void>> = [];
  for (const [type, ids] of byType) {
    if (!nodeTypeIsVisible(caps, type)) continue;
    const query = QUERIES[type];
    if (!query) continue;
    const castedIds = castIds(type, ids, query.cast);
    if (!castedIds.length) continue;

    jobs.push(
      safeQuery(query.sql, [castedIds]).then((rows) => {
        for (const row of rows) {
          const id = str(row.id);
          if (!id) continue;
          const ref: TraceabilityNodeRef = { type, id };
          const meta = collectMeta(row);
          let masked = false;

          // RGPD : le pointage reste une preuve, l'identité de l'opérateur est
          // un droit à part. On remplace, on ne supprime pas la preuve.
          if (type === "pointage" && meta) {
            const operatorId = num(meta.operator_user_id);
            const operatorLabel = str(meta.operator_label);
            const shown = maskOperatorLabel(caps, operatorId, operatorLabel);
            if (!caps.personal_data_read) {
              masked = true;
              delete meta.operator_label;
              delete meta.operator_user_id;
            }
            if (shown) meta.operator = shown;
          }

          out.set(nodeKey(ref), {
            node_id: nodeKey(ref),
            type,
            type_label: NODE_TYPE_LABELS[type],
            family: NODE_TYPE_FAMILY[type],
            id,
            code: str(row.code) ?? id,
            label: str(row.label) ?? str(row.code) ?? NODE_TYPE_LABELS[type],
            status: str(row.status),
            date: iso(row.date),
            qty: num(row.qty),
            unit: str(row.unit),
            route: authoritativeRoute(ref),
            masked,
            meta,
          });
        }
      })
    );
  }

  await Promise.all(jobs);

  for (const ref of refs) {
    const key = nodeKey(ref);
    if (out.has(key)) continue;
    out.set(key, {
      node_id: key,
      type: ref.type,
      type_label: NODE_TYPE_LABELS[ref.type] ?? ref.type,
      family: NODE_TYPE_FAMILY[ref.type] ?? "preuve",
      id: ref.id,
      code: "—",
      label: `${NODE_TYPE_LABELS[ref.type] ?? ref.type} introuvable`,
      status: null,
      date: null,
      qty: null,
      unit: null,
      route: null,
      masked: false,
      meta: { orphan: true },
    });
  }

  return out;
}
