// Dossier as-built enrichi (#142) — sections de preuve additionnelles.
//
// Le dossier historique ne contenait que : lot, OF, BL, NC. Il ne prouvait donc
// ni ce qui avait été consommé, ni comment la pièce avait été fabriquée, ni
// avec quel instrument elle avait été mesurée. Ce module ajoute les sections
// manquantes, en LECTURE seule, depuis les tables autoritaires.
//
// Aucune requête ici ne sélectionne `storage_path`, `stored_name` ni aucun
// chemin serveur : le dossier référence des documents par identifiant opaque et
// empreinte, jamais par emplacement disque.

import pool from "../../../config/database";

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

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type AsBuiltTechnicalVersion = {
  of_id: number;
  of_numero: string;
  piece_version_id: string | null;
  indice: string | null;
  plan_reference: string | null;
  snapshot_sha256: string | null;
  snapshot_at: string | null;
};

export type AsBuiltConsumedLot = {
  consumption_id: string;
  of_id: number;
  of_numero: string;
  lot_id: string;
  lot_code: string;
  supplier_lot_code: string | null;
  article_code: string;
  article_designation: string | null;
  qty: number | null;
  unit: string | null;
  effective_at: string | null;
  status: string;
  proof_source: string;
};

export type AsBuiltOperation = {
  operation_id: string;
  of_id: number;
  of_numero: string;
  phase: number | null;
  designation: string | null;
  status: string | null;
  machine_code: string | null;
  machine_label: string | null;
  planned_minutes: number | null;
  real_minutes: number | null;
  /** Pseudonymisé si l'appelant n'a pas `personal_data_read`. */
  operators: string[];
  clocking_count: number;
};

export type AsBuiltProductionReceipt = {
  receipt_id: string;
  of_id: number;
  of_numero: string;
  qty_ok: number | null;
  qty_scrap: number | null;
  qty_rework: number | null;
  quality_status: string | null;
  stock_movement_id: string | null;
  created_at: string | null;
};

export type AsBuiltStockMovement = {
  movement_id: string;
  movement_no: string | null;
  movement_type: string;
  status: string;
  qty: number | null;
  unit: string | null;
  effective_at: string | null;
  source_document_type: string | null;
  reversal_of_id: string | null;
};

export type AsBuiltMeasurement = {
  measurement_id: string;
  control_id: string;
  control_reference: string | null;
  characteristic: string;
  nominal: number | null;
  tolerance_min: number | null;
  tolerance_max: number | null;
  measured_value: number | null;
  unit: string | null;
  result: string | null;
  measured_at: string | null;
  instrument_id: string | null;
  instrument_code: string | null;
  instrument_designation: string | null;
  certificate_id: string | null;
  certificate_number: string | null;
  certificate_valid_at_measure: boolean | null;
};

export type AsBuiltControl = {
  control_id: string;
  reference: string | null;
  control_type: string | null;
  status: string | null;
  verdict: string | null;
  verdict_computed: string | null;
  control_date: string | null;
  plan_version: number | null;
  plan_snapshot_sha256: string | null;
  qty_controlled: number | null;
  qty_conforming: number | null;
  unit: string | null;
};

export type AsBuiltReleaseDecision = {
  decision_id: string;
  decision: string | null;
  verdict: string | null;
  qty: number | null;
  unit: string | null;
  decided_at: string | null;
  derogation_code: string | null;
};

export type AsBuiltDerogation = {
  derogation_id: string;
  code: string;
  status: string;
  derogation_type: string | null;
  max_qty: number | null;
  consumed_qty: number | null;
  unit: string | null;
  valid_to: string | null;
};

export type AsBuiltAllocation = {
  allocation_id: string;
  bon_livraison_id: string;
  bon_livraison_numero: string;
  ligne_id: string;
  designation: string | null;
  qty: number | null;
  unit: string | null;
  stock_movement_line_id: string | null;
  reservation_id: string | null;
};

export type AsBuiltDeliveryProof = {
  proof_id: string;
  bon_livraison_id: string;
  bon_livraison_numero: string;
  proof_type: string | null;
  delivered_at: string | null;
  received_by_name: string | null;
  document_id: string | null;
};

export type AsBuiltEnrichment = {
  technical_versions: AsBuiltTechnicalVersion[];
  consumed_lots: AsBuiltConsumedLot[];
  operations: AsBuiltOperation[];
  production_receipts: AsBuiltProductionReceipt[];
  stock_movements: AsBuiltStockMovement[];
  controls: AsBuiltControl[];
  measurements: AsBuiltMeasurement[];
  release_decisions: AsBuiltReleaseDecision[];
  derogations: AsBuiltDerogation[];
  allocations: AsBuiltAllocation[];
  delivery_proofs: AsBuiltDeliveryProof[];
  lot_status: { current: string | null; note: string | null };
};

/* -------------------------------------------------------------------------- */
/* Chargement                                                                 */
/* -------------------------------------------------------------------------- */

export async function repoLoadAsbuiltEnrichment(params: {
  lotId: string;
  ofIds: number[];
  blIds: string[];
  /** Sans ce droit, les noms d'opérateurs sont remplacés par un pseudonyme. */
  canReadPersonalData: boolean;
}): Promise<AsBuiltEnrichment> {
  const { lotId, ofIds, blIds } = params;
  const hasOf = ofIds.length > 0;
  const hasBl = blIds.length > 0;

  const [
    versionRows,
    consumptionRows,
    operationRows,
    receiptRows,
    movementRows,
    controlRows,
    measurementRows,
    decisionRows,
    derogationRows,
    allocationRows,
    proofRows,
    lotRows,
  ] = await Promise.all([
    hasOf
      ? safeQuery(
          `SELECT o.id::text AS of_id, o.numero AS of_numero,
                  COALESCE(s.piece_technique_version_id::text, o.piece_technique_version_id::text) AS piece_version_id,
                  v.indice, v.plan_reference,
                  COALESCE(s.snapshot_sha256, o.technical_snapshot_sha256) AS snapshot_sha256,
                  COALESCE(s.created_at::text, o.technical_snapshot_at::text) AS snapshot_at
             FROM public.ordres_fabrication o
             LEFT JOIN public.of_technical_snapshots s ON s.of_id = o.id
             LEFT JOIN public.piece_technique_versions v
                    ON v.id = COALESCE(s.piece_technique_version_id, o.piece_technique_version_id)
            WHERE o.id = ANY($1::bigint[])`,
          [ofIds]
        )
      : Promise.resolve([]),

    hasOf
      ? safeQuery(
          `SELECT c.id::text AS consumption_id, c.of_id::text AS of_id, o.numero AS of_numero,
                  c.lot_id::text AS lot_id, l.lot_code, l.supplier_lot_code,
                  a.code AS article_code, a.designation AS article_designation,
                  c.qty::float8 AS qty, c.unit_code AS unit,
                  c.effective_at::text AS effective_at, c.status, c.source AS proof_source
             FROM public.of_material_consumptions c
             JOIN public.ordres_fabrication o ON o.id = c.of_id
             JOIN public.lots l ON l.id = c.lot_id
             JOIN public.articles a ON a.id = c.article_id
            WHERE c.of_id = ANY($1::bigint[]) AND c.status <> 'CANCELLED'
            ORDER BY c.effective_at ASC
            LIMIT 500`,
          [ofIds]
        )
      : Promise.resolve([]),

    hasOf
      ? safeQuery(
          `SELECT op.id::text AS operation_id, op.of_id::text AS of_id, o.numero AS of_numero,
                  op.phase, op.designation, op.status::text AS status,
                  m.code AS machine_code, COALESCE(m.display_name, m.name) AS machine_label,
                  op.temps_total_planned::float8 AS planned_minutes,
                  op.temps_total_real::float8 AS real_minutes,
                  COALESCE(pt.clocking_count, 0)::int AS clocking_count,
                  COALESCE(pt.operator_ids, ARRAY[]::int[]) AS operator_ids,
                  COALESCE(pt.operator_labels, ARRAY[]::text[]) AS operator_labels
             FROM public.of_operations op
             JOIN public.ordres_fabrication o ON o.id = op.of_id
             LEFT JOIN public.machines m ON m.id = op.machine_id
             LEFT JOIN LATERAL (
               SELECT COUNT(*)::int AS clocking_count,
                      ARRAY_AGG(DISTINCT p.operator_user_id) AS operator_ids,
                      ARRAY_AGG(DISTINCT NULLIF(TRIM(COALESCE(u.name,'') || ' ' || COALESCE(u.surname,'')), '')) AS operator_labels
                 FROM public.production_pointages p
                 LEFT JOIN public.users u ON u.id = p.operator_user_id
                WHERE p.operation_id = op.id AND p.status <> 'CANCELLED'
             ) pt ON TRUE
            WHERE op.of_id = ANY($1::bigint[])
            ORDER BY op.of_id ASC, op.phase ASC
            LIMIT 500`,
          [ofIds]
        )
      : Promise.resolve([]),

    hasOf
      ? safeQuery(
          `SELECT r.id::text AS receipt_id, r.of_id::text AS of_id, o.numero AS of_numero,
                  r.qty_ok::float8 AS qty_ok, r.qty_scrap::float8 AS qty_scrap,
                  r.qty_rework::float8 AS qty_rework, r.quality_status,
                  r.stock_movement_id::text AS stock_movement_id, r.created_at::text AS created_at
             FROM public.of_receipts r
             JOIN public.ordres_fabrication o ON o.id = r.of_id
            WHERE r.lot_id = $1::uuid OR r.of_id = ANY($2::bigint[])
            ORDER BY r.created_at ASC
            LIMIT 200`,
          [lotId, ofIds]
        )
      : Promise.resolve([]),

    safeQuery(
      `SELECT m.id::text AS movement_id, m.movement_no, m.movement_type::text AS movement_type,
              m.status, sl.qty::float8 AS qty, sl.unite AS unit,
              COALESCE(m.posted_at::text, m.effective_at::text) AS effective_at,
              m.source_document_type, m.reversal_of_id::text AS reversal_of_id
         FROM public.stock_movement_lines sl
         JOIN public.stock_movements m ON m.id = sl.movement_id
        WHERE sl.lot_id = $1::uuid
        ORDER BY COALESCE(m.posted_at, m.effective_at) ASC
        LIMIT 300`,
      [lotId]
    ),

    safeQuery(
      `SELECT qc.id::text AS control_id, qc.reference, qc.control_type::text AS control_type,
              qc.status::text AS status, qc.verdict, qc.verdict_computed,
              qc.control_date::text AS control_date, qc.plan_version,
              qc.plan_snapshot_sha256, qc.qty_controlled::float8 AS qty_controlled,
              qc.qty_conforming::float8 AS qty_conforming, qc.unite AS unit
         FROM public.quality_control qc
        WHERE qc.lot_id = $1::uuid ${hasOf ? "OR qc.of_id = ANY($2::bigint[])" : ""}
        ORDER BY qc.control_date ASC
        LIMIT 200`,
      hasOf ? [lotId, ofIds] : [lotId]
    ),

    safeQuery(
      `SELECT p.id::text AS measurement_id, p.quality_control_id::text AS control_id,
              qc.reference AS control_reference, p.characteristic,
              p.nominal_value::float8 AS nominal, p.tolerance_min::float8 AS tolerance_min,
              p.tolerance_max::float8 AS tolerance_max, p.measured_value::float8 AS measured_value,
              p.unit, p.result::text AS result,
              COALESCE(p.measured_at::text, p.created_at::text) AS measured_at,
              p.instrument_id::text AS instrument_id,
              e.code AS instrument_code, e.designation AS instrument_designation,
              cert.id::text AS certificate_id, cert.numero_externe AS certificate_number,
              CASE WHEN p.instrument_id IS NULL THEN NULL ELSE (cert.id IS NOT NULL) END AS certificate_valid_at_measure
         FROM public.quality_control_points p
         JOIN public.quality_control qc ON qc.id = p.quality_control_id
         LEFT JOIN public.metrologie_equipements e ON e.id = p.instrument_id
         LEFT JOIN LATERAL (
           SELECT c.id, c.numero_externe
             FROM public.metrologie_certificats c
            WHERE c.equipement_id = p.instrument_id
              AND c.deleted_at IS NULL
              AND c.resultat = 'CONFORME'
              AND c.date_etalonnage <= COALESCE(p.measured_at, p.created_at)::date
              AND (c.date_echeance IS NULL OR c.date_echeance >= COALESCE(p.measured_at, p.created_at)::date)
            ORDER BY c.date_etalonnage DESC
            LIMIT 1
         ) cert ON TRUE
        WHERE qc.lot_id = $1::uuid ${hasOf ? "OR qc.of_id = ANY($2::bigint[])" : ""}
        ORDER BY COALESCE(p.measured_at, p.created_at) ASC
        LIMIT 500`,
      hasOf ? [lotId, ofIds] : [lotId]
    ),

    safeQuery(
      `SELECT d.id::text AS decision_id, d.decision, d.verdict, d.qty::float8 AS qty,
              d.unite AS unit, d.decided_at::text AS decided_at, der.code AS derogation_code
         FROM public.quality_release_decision d
         JOIN public.quality_control qc ON qc.id = d.quality_control_id
         LEFT JOIN public.quality_derogation der ON der.id = d.derogation_id
        WHERE qc.lot_id = $1::uuid ${hasOf ? "OR qc.of_id = ANY($2::bigint[])" : ""}
        ORDER BY d.decided_at ASC
        LIMIT 200`,
      hasOf ? [lotId, ofIds] : [lotId]
    ),

    safeQuery(
      `SELECT d.id::text AS derogation_id, d.code, d.status, d.derogation_type,
              d.max_qty::float8 AS max_qty, d.consumed_qty::float8 AS consumed_qty,
              d.unite AS unit, d.valid_to::text AS valid_to
         FROM public.quality_derogation d
        WHERE d.lot_id = $1::uuid ${hasOf ? "OR d.of_id = ANY($2::bigint[])" : ""}
        ORDER BY d.created_at ASC
        LIMIT 100`,
      hasOf ? [lotId, ofIds] : [lotId]
    ),

    safeQuery(
      `SELECT a.id::text AS allocation_id, bl.id::text AS bon_livraison_id, bl.numero AS bon_livraison_numero,
              bll.id::text AS ligne_id, bll.designation, a.quantite::float8 AS qty, a.unite AS unit,
              a.stock_movement_line_id::text AS stock_movement_line_id,
              a.reservation_id::text AS reservation_id
         FROM public.bon_livraison_ligne_allocations a
         JOIN public.bon_livraison_ligne bll ON bll.id = a.bon_livraison_ligne_id
         JOIN public.bon_livraison bl ON bl.id = bll.bon_livraison_id
        WHERE a.lot_id = $1::uuid
        ORDER BY bl.date_creation ASC
        LIMIT 200`,
      [lotId]
    ),

    hasBl
      ? safeQuery(
          `SELECT p.id::text AS proof_id, p.bon_livraison_id::text AS bon_livraison_id,
                  bl.numero AS bon_livraison_numero, p.proof_type,
                  p.delivered_at::text AS delivered_at, p.received_by_name,
                  p.document_id::text AS document_id
             FROM public.bon_livraison_delivery_proofs p
             JOIN public.bon_livraison bl ON bl.id = p.bon_livraison_id
            WHERE p.bon_livraison_id = ANY($1::uuid[])
            ORDER BY p.delivered_at ASC
            LIMIT 100`,
          [blIds]
        )
      : Promise.resolve([]),

    safeQuery(`SELECT lot_status, lot_status_note FROM public.lots WHERE id = $1::uuid`, [lotId]),
  ]);

  const toNumber = (v: unknown) => {
    const n = num(v);
    return n === null ? 0 : n;
  };

  return {
    technical_versions: versionRows.map((r) => ({
      of_id: toNumber(r.of_id),
      of_numero: str(r.of_numero) ?? "",
      piece_version_id: str(r.piece_version_id),
      indice: str(r.indice),
      plan_reference: str(r.plan_reference),
      snapshot_sha256: str(r.snapshot_sha256),
      snapshot_at: str(r.snapshot_at),
    })),
    consumed_lots: consumptionRows.map((r) => ({
      consumption_id: str(r.consumption_id) ?? "",
      of_id: toNumber(r.of_id),
      of_numero: str(r.of_numero) ?? "",
      lot_id: str(r.lot_id) ?? "",
      lot_code: str(r.lot_code) ?? "",
      supplier_lot_code: str(r.supplier_lot_code),
      article_code: str(r.article_code) ?? "",
      article_designation: str(r.article_designation),
      qty: num(r.qty),
      unit: str(r.unit),
      effective_at: str(r.effective_at),
      status: str(r.status) ?? "POSTED",
      proof_source: str(r.proof_source) ?? "STOCK_MOVEMENT_POST",
    })),
    operations: operationRows.map((r) => {
      const ids = Array.isArray(r.operator_ids) ? (r.operator_ids as unknown[]) : [];
      const labels = Array.isArray(r.operator_labels) ? (r.operator_labels as unknown[]) : [];
      // RGPD : la preuve est le pointage, pas l'identité. Sans le droit de lire
      // une donnée personnelle, le dossier reste vérifiable sous pseudonyme.
      const operators = params.canReadPersonalData
        ? labels.map((l) => str(l)).filter((l): l is string => Boolean(l))
        : ids
            .map((id) => num(id))
            .filter((id): id is number => id !== null)
            .map((id) => `Opérateur #${id}`);
      return {
        operation_id: str(r.operation_id) ?? "",
        of_id: toNumber(r.of_id),
        of_numero: str(r.of_numero) ?? "",
        phase: num(r.phase),
        designation: str(r.designation),
        status: str(r.status),
        machine_code: str(r.machine_code),
        machine_label: str(r.machine_label),
        planned_minutes: num(r.planned_minutes),
        real_minutes: num(r.real_minutes),
        operators,
        clocking_count: toNumber(r.clocking_count),
      };
    }),
    production_receipts: receiptRows.map((r) => ({
      receipt_id: str(r.receipt_id) ?? "",
      of_id: toNumber(r.of_id),
      of_numero: str(r.of_numero) ?? "",
      qty_ok: num(r.qty_ok),
      qty_scrap: num(r.qty_scrap),
      qty_rework: num(r.qty_rework),
      quality_status: str(r.quality_status),
      stock_movement_id: str(r.stock_movement_id),
      created_at: str(r.created_at),
    })),
    stock_movements: movementRows.map((r) => ({
      movement_id: str(r.movement_id) ?? "",
      movement_no: str(r.movement_no),
      movement_type: str(r.movement_type) ?? "",
      status: str(r.status) ?? "",
      qty: num(r.qty),
      unit: str(r.unit),
      effective_at: str(r.effective_at),
      source_document_type: str(r.source_document_type),
      reversal_of_id: str(r.reversal_of_id),
    })),
    controls: controlRows.map((r) => ({
      control_id: str(r.control_id) ?? "",
      reference: str(r.reference),
      control_type: str(r.control_type),
      status: str(r.status),
      verdict: str(r.verdict),
      verdict_computed: str(r.verdict_computed),
      control_date: str(r.control_date),
      plan_version: num(r.plan_version),
      plan_snapshot_sha256: str(r.plan_snapshot_sha256),
      qty_controlled: num(r.qty_controlled),
      qty_conforming: num(r.qty_conforming),
      unit: str(r.unit),
    })),
    measurements: measurementRows.map((r) => ({
      measurement_id: str(r.measurement_id) ?? "",
      control_id: str(r.control_id) ?? "",
      control_reference: str(r.control_reference),
      characteristic: str(r.characteristic) ?? "",
      nominal: num(r.nominal),
      tolerance_min: num(r.tolerance_min),
      tolerance_max: num(r.tolerance_max),
      measured_value: num(r.measured_value),
      unit: str(r.unit),
      result: str(r.result),
      measured_at: str(r.measured_at),
      instrument_id: str(r.instrument_id),
      instrument_code: str(r.instrument_code),
      instrument_designation: str(r.instrument_designation),
      certificate_id: str(r.certificate_id),
      certificate_number: str(r.certificate_number),
      certificate_valid_at_measure:
        r.certificate_valid_at_measure === null || r.certificate_valid_at_measure === undefined
          ? null
          : Boolean(r.certificate_valid_at_measure),
    })),
    release_decisions: decisionRows.map((r) => ({
      decision_id: str(r.decision_id) ?? "",
      decision: str(r.decision),
      verdict: str(r.verdict),
      qty: num(r.qty),
      unit: str(r.unit),
      decided_at: str(r.decided_at),
      derogation_code: str(r.derogation_code),
    })),
    derogations: derogationRows.map((r) => ({
      derogation_id: str(r.derogation_id) ?? "",
      code: str(r.code) ?? "",
      status: str(r.status) ?? "",
      derogation_type: str(r.derogation_type),
      max_qty: num(r.max_qty),
      consumed_qty: num(r.consumed_qty),
      unit: str(r.unit),
      valid_to: str(r.valid_to),
    })),
    allocations: allocationRows.map((r) => ({
      allocation_id: str(r.allocation_id) ?? "",
      bon_livraison_id: str(r.bon_livraison_id) ?? "",
      bon_livraison_numero: str(r.bon_livraison_numero) ?? "",
      ligne_id: str(r.ligne_id) ?? "",
      designation: str(r.designation),
      qty: num(r.qty),
      unit: str(r.unit),
      stock_movement_line_id: str(r.stock_movement_line_id),
      reservation_id: str(r.reservation_id),
    })),
    delivery_proofs: proofRows.map((r) => ({
      proof_id: str(r.proof_id) ?? "",
      bon_livraison_id: str(r.bon_livraison_id) ?? "",
      bon_livraison_numero: str(r.bon_livraison_numero) ?? "",
      proof_type: str(r.proof_type),
      delivered_at: str(r.delivered_at),
      received_by_name: params.canReadPersonalData ? str(r.received_by_name) : null,
      document_id: str(r.document_id),
    })),
    lot_status: {
      current: str(lotRows[0]?.lot_status),
      note: str(lotRows[0]?.lot_status_note),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Anomalies de couverture du dossier                                         */
/* -------------------------------------------------------------------------- */

export type AsBuiltCoverageWarning = {
  code: string;
  level: "info" | "warning" | "danger";
  message: string;
};

/**
 * Ce qui MANQUE au dossier est aussi important que ce qu'il contient. Un
 * dossier as-built qui tait ses lacunes est un faux document de conformité.
 */
export function computeAsbuiltCoverage(
  enrichment: AsBuiltEnrichment,
  context: { hasOf: boolean; hasShipping: boolean; openNc: number }
): AsBuiltCoverageWarning[] {
  const out: AsBuiltCoverageWarning[] = [];

  if (!context.hasOf) {
    out.push({
      code: "NO_PRODUCTION_LINK",
      level: "warning",
      message: "Aucun ordre de fabrication n'est rattaché à ce lot : l'origine de production n'est pas prouvée.",
    });
  }

  if (context.hasOf && enrichment.consumed_lots.length === 0) {
    out.push({
      code: "NO_MATERIAL_CONSUMPTION",
      level: "warning",
      message:
        "Aucune consommation matière prouvée n'est enregistrée pour les OF de ce lot : lien historique non renseigné.",
    });
  }

  const missingSnapshot = enrichment.technical_versions.filter((v) => !v.snapshot_sha256);
  if (missingSnapshot.length) {
    out.push({
      code: "TECHNICAL_SNAPSHOT_MISSING",
      level: "warning",
      message: `${missingSnapshot.length} OF sans empreinte de version technique figée : la définition réellement fabriquée n'est pas vérifiable.`,
    });
  }

  if (enrichment.production_receipts.length === 0 && context.hasOf) {
    out.push({
      code: "NO_PRODUCTION_RECEIPT",
      level: "warning",
      message: "Aucune réception de production : l'entrée en stock du lot fabriqué n'est pas prouvée.",
    });
  }

  const withoutInstrument = enrichment.measurements.filter((m) => !m.instrument_id);
  if (withoutInstrument.length) {
    out.push({
      code: "MEASUREMENT_WITHOUT_INSTRUMENT",
      level: "warning",
      message: `${withoutInstrument.length} mesure(s) sans instrument déclaré : elles ne sont pas opposables.`,
    });
  }

  const withoutCertificate = enrichment.measurements.filter(
    (m) => m.instrument_id && m.certificate_valid_at_measure === false
  );
  if (withoutCertificate.length) {
    out.push({
      code: "MEASUREMENT_WITHOUT_VALID_CERTIFICATE",
      level: "danger",
      message: `${withoutCertificate.length} mesure(s) réalisées sans certificat métrologique conforme valide à la date.`,
    });
  }

  if (context.hasShipping && enrichment.allocations.length === 0) {
    out.push({
      code: "SHIPPING_WITHOUT_ALLOCATION",
      level: "warning",
      message: "Le lot est lié à une livraison sans allocation : la quantité expédiée n'est pas traçable au lot.",
    });
  }

  const allocationsWithoutMovement = enrichment.allocations.filter((a) => !a.stock_movement_line_id);
  if (allocationsWithoutMovement.length) {
    out.push({
      code: "ALLOCATION_WITHOUT_MOVEMENT",
      level: "warning",
      message: `${allocationsWithoutMovement.length} allocation(s) sans mouvement de sortie rattaché.`,
    });
  }

  if (context.openNc > 0) {
    out.push({
      code: "OPEN_NON_CONFORMITY",
      level: "danger",
      message: `${context.openNc} non-conformité(s) ouverte(s) concernent ce lot au moment de la génération.`,
    });
  }

  return out;
}
