// Traçabilité industrielle 360 (#142) — détection des anomalies de données.
//
// Ce module DÉTECTE et PRÉSENTE. Il ne corrige rien, ne complète rien,
// n'invente aucun chaînage manquant. Une lacune signalée reste une lacune :
// c'est au métier de décider quoi en faire, dans le module propriétaire.
//
// Chaque contrôle est une requête batchée sur les nœuds déjà présents dans le
// graphe : aucun balayage de table complète, aucun coût qui dépende du volume
// global de l'ERP.

import pool from "../../../config/database";

import {
  DATA_QUALITY_LABELS,
  nodeKey,
  type DataQualityCode,
  type DataQualityIssue,
  type TraceabilityNodeRef,
  type TraceabilityNodeType,
} from "../domain/traceability-model";
import type { GraphEdge } from "../domain/traceability-graph";
import type { TraceabilityNodeDTO } from "./traceability-hydrate.repository";

type Row = Record<string, unknown>;

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

function idsOf(refs: TraceabilityNodeRef[], type: TraceabilityNodeType): string[] {
  return refs.filter((r) => r.type === type).map((r) => r.id);
}

function issue(
  code: DataQualityCode,
  level: DataQualityIssue["level"],
  ref: TraceabilityNodeRef | null,
  message?: string,
  details?: Record<string, unknown>
): DataQualityIssue {
  return {
    code,
    level,
    node_id: ref ? nodeKey(ref) : null,
    message: message ?? DATA_QUALITY_LABELS[code],
    details: details ?? null,
  };
}

/**
 * Audit de qualité de données sur le périmètre du graphe courant.
 *
 * Volontairement conservateur : on ne signale que ce qui est vérifiable par
 * une requête, jamais par intuition. Un lot dont l'origine n'a simplement pas
 * été explorée (limite de profondeur) n'est PAS signalé comme « sans origine ».
 */
export async function repoAuditTraceabilityIssues(
  refs: TraceabilityNodeRef[],
  hydrated: Map<string, TraceabilityNodeDTO>,
  edges: GraphEdge[]
): Promise<DataQualityIssue[]> {
  const out: DataQualityIssue[] = [];

  // ── 1. Relations orphelines : nœud référencé mais introuvable en base ─────
  for (const ref of refs) {
    const dto = hydrated.get(nodeKey(ref));
    if (dto?.meta?.orphan === true) {
      out.push(
        issue(
          "ORPHAN_RELATION",
          "warning",
          ref,
          `Un ${dto.type_label.toLowerCase()} est référencé par une relation mais introuvable en base.`
        )
      );
    }
  }

  // ── 2. Lien historique non renseigné ─────────────────────────────────────
  for (const edge of edges) {
    if (edge.proof_level !== "unknown") continue;
    out.push(
      issue("ORPHAN_RELATION", "info", edge.to, DATA_QUALITY_LABELS.ORPHAN_RELATION, {
        edge_id: edge.edge_id,
      })
    );
  }

  const lotIds = idsOf(refs, "lot");
  const ofIds = idsOf(refs, "of");
  const blIds = idsOf(refs, "bon_livraison");
  const controlIds = idsOf(refs, "quality_control");
  const measurementIds = idsOf(refs, "quality_measurement");
  const packIds = idsOf(refs, "asbuilt_pack");

  const jobs: Array<Promise<void>> = [];

  /* ── Lots sans origine prouvée ───────────────────────────────────────── */
  if (lotIds.length) {
    jobs.push(
      safeQuery(
        `SELECT l.id::text AS id, l.lot_code
           FROM public.lots l
          WHERE l.id = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM public.reception_fournisseur_lignes rl WHERE rl.lot_id = l.id)
            AND NOT EXISTS (SELECT 1 FROM public.of_output_lots ool WHERE ool.lot_id = l.id)
            AND NOT EXISTS (SELECT 1 FROM public.stock_lot_genealogy_edges g WHERE g.child_lot_id = l.id)`,
        [lotIds]
      ).then((rows) => {
        for (const r of rows) {
          out.push(
            issue(
              "LOT_WITHOUT_ORIGIN",
              "warning",
              { type: "lot", id: String(r.id) },
              `Le lot ${r.lot_code ?? ""} n'a ni réception fournisseur, ni OF producteur, ni parent de généalogie. Lien historique non renseigné.`
            )
          );
        }
      })
    );

    /* ── Lot fabriqué sans réception de production ─────────────────────── */
    jobs.push(
      safeQuery(
        `SELECT DISTINCT l.id::text AS id, l.lot_code
           FROM public.lots l
           JOIN public.of_output_lots ool ON ool.lot_id = l.id
          WHERE l.id = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM public.of_receipts rc WHERE rc.lot_id = l.id)`,
        [lotIds]
      ).then((rows) => {
        for (const r of rows) {
          out.push(
            issue(
              "MANUFACTURED_LOT_WITHOUT_RECEIPT",
              "warning",
              { type: "lot", id: String(r.id) },
              `Le lot fabriqué ${r.lot_code ?? ""} n'a pas de réception de production : l'entrée en stock n'est pas prouvée.`
            )
          );
        }
      })
    );
  }

  /* ── OF sans version technique figée ─────────────────────────────────── */
  if (ofIds.length) {
    jobs.push(
      safeQuery(
        `SELECT o.id::text AS id, o.numero,
                (o.technical_snapshot_sha256 IS NULL) AS hash_missing,
                NOT EXISTS (SELECT 1 FROM public.of_technical_snapshots s WHERE s.of_id = o.id) AS snapshot_missing
           FROM public.ordres_fabrication o
          WHERE o.id = ANY($1::bigint[])
            AND (o.technical_snapshot_sha256 IS NULL
                 OR NOT EXISTS (SELECT 1 FROM public.of_technical_snapshots s WHERE s.of_id = o.id))`,
        [ofIds]
      ).then((rows) => {
        for (const r of rows) {
          const ref: TraceabilityNodeRef = { type: "of", id: String(r.id) };
          if (r.snapshot_missing === true) {
            out.push(
              issue(
                "OF_WITHOUT_TECHNICAL_SNAPSHOT",
                "warning",
                ref,
                `L'OF ${r.numero ?? ""} n'a pas de snapshot technique : la version réellement fabriquée n'est pas figée.`
              )
            );
          } else if (r.hash_missing === true) {
            out.push(
              issue(
                "SNAPSHOT_HASH_MISSING",
                "warning",
                ref,
                `L'OF ${r.numero ?? ""} porte un snapshot sans empreinte SHA-256 : l'intégrité n'est pas vérifiable.`
              )
            );
          }
        }
      })
    );

    /* ── Consommation sans mouvement comptabilisé ───────────────────────── */
    jobs.push(
      safeQuery(
        `SELECT c.id::text AS id, c.of_id::text AS of_id
           FROM public.of_material_consumptions c
           LEFT JOIN public.stock_movements m ON m.id = c.stock_movement_id
          WHERE c.of_id = ANY($1::bigint[])
            AND c.status <> 'CANCELLED'
            AND (m.id IS NULL OR m.status <> 'POSTED')`,
        [ofIds]
      ).then((rows) => {
        for (const r of rows) {
          out.push(
            issue(
              "CONSUMPTION_WITHOUT_POSTED_MOVEMENT",
              "danger",
              { type: "of", id: String(r.of_id) },
              "Une consommation matière n'est pas adossée à un mouvement comptabilisé.",
              { consumption_id: String(r.id) }
            )
          );
        }
      })
    );
  }

  /* ── Livraison sans allocation / allocation sans mouvement ───────────── */
  if (blIds.length) {
    jobs.push(
      safeQuery(
        `SELECT bl.id::text AS id, bl.numero,
                COUNT(bll.id) FILTER (WHERE bll.id IS NOT NULL)::int AS line_count,
                COUNT(a.id) FILTER (WHERE a.id IS NOT NULL)::int AS alloc_count,
                COUNT(a.id) FILTER (WHERE a.id IS NOT NULL AND a.stock_movement_line_id IS NULL)::int AS alloc_without_movement
           FROM public.bon_livraison bl
           LEFT JOIN public.bon_livraison_ligne bll ON bll.bon_livraison_id = bl.id
           LEFT JOIN public.bon_livraison_ligne_allocations a ON a.bon_livraison_ligne_id = bll.id
          WHERE bl.id = ANY($1::uuid[])
          GROUP BY bl.id, bl.numero`,
        [blIds]
      ).then((rows) => {
        for (const r of rows) {
          const ref: TraceabilityNodeRef = { type: "bon_livraison", id: String(r.id) };
          const lineCount = Number(r.line_count ?? 0);
          const allocCount = Number(r.alloc_count ?? 0);
          const allocWithoutMovement = Number(r.alloc_without_movement ?? 0);
          if (lineCount > 0 && allocCount === 0) {
            out.push(
              issue(
                "DELIVERY_WITHOUT_ALLOCATION",
                "warning",
                ref,
                `Le BL ${r.numero ?? ""} n'a aucune allocation de lot : ce qui a été expédié n'est pas traçable au lot.`
              )
            );
          }
          if (allocWithoutMovement > 0) {
            out.push(
              issue(
                "ALLOCATION_WITHOUT_OUTBOUND_MOVEMENT",
                "warning",
                ref,
                `${allocWithoutMovement} allocation(s) du BL ${r.numero ?? ""} ne pointent aucun mouvement de sortie.`
              )
            );
          }
        }
      })
    );
  }

  /* ── Contrôle sans objet rattaché ────────────────────────────────────── */
  if (controlIds.length) {
    jobs.push(
      safeQuery(
        `SELECT qc.id::text AS id, qc.reference
           FROM public.quality_control qc
          WHERE qc.id = ANY($1::uuid[])
            AND qc.lot_id IS NULL AND qc.of_id IS NULL AND qc.article_id IS NULL
            AND qc.reception_ligne_id IS NULL AND qc.bon_livraison_id IS NULL
            AND qc.piece_technique_id IS NULL`,
        [controlIds]
      ).then((rows) => {
        for (const r of rows) {
          out.push(
            issue(
              "CONTROL_WITHOUT_OBJECT",
              "warning",
              { type: "quality_control", id: String(r.id) },
              `Le contrôle ${r.reference ?? ""} n'est rattaché à aucun objet : il ne prouve rien.`
            )
          );
        }
      })
    );
  }

  /* ── Mesure sans instrument / sans certificat valide à la date ───────── */
  if (measurementIds.length) {
    jobs.push(
      safeQuery(
        `SELECT p.id::text AS id, p.characteristic, p.criticality,
                (p.instrument_id IS NULL) AS no_instrument,
                CASE
                  WHEN p.instrument_id IS NULL THEN false
                  ELSE NOT EXISTS (
                    SELECT 1 FROM public.metrologie_certificats c
                     WHERE c.equipement_id = p.instrument_id
                       AND c.deleted_at IS NULL
                       AND c.resultat = 'CONFORME'
                       AND c.date_etalonnage <= COALESCE(p.measured_at, p.created_at)::date
                       AND (c.date_echeance IS NULL
                            OR c.date_echeance >= COALESCE(p.measured_at, p.created_at)::date)
                  )
                END AS no_valid_certificate
           FROM public.quality_control_points p
          WHERE p.id = ANY($1::uuid[])`,
        [measurementIds]
      ).then((rows) => {
        for (const r of rows) {
          const ref: TraceabilityNodeRef = { type: "quality_measurement", id: String(r.id) };
          if (r.no_instrument === true) {
            out.push(
              issue(
                "MEASUREMENT_WITHOUT_INSTRUMENT",
                "warning",
                ref,
                `La mesure « ${r.characteristic ?? ""} » ne déclare aucun instrument : elle n'est pas opposable.`
              )
            );
          } else if (r.no_valid_certificate === true) {
            out.push(
              issue(
                "MEASUREMENT_WITHOUT_VALID_CERTIFICATE",
                "danger",
                ref,
                `Aucun certificat conforme ne couvrait l'instrument à la date de la mesure « ${r.characteristic ?? ""} ».`
              )
            );
          }
        }
      })
    );
  }

  /* ── Dossier as-built sans fichier ───────────────────────────────────── */
  if (packIds.length) {
    jobs.push(
      safeQuery(
        `SELECT p.id::text AS id, p.version
           FROM public.asbuilt_pack_versions p
          WHERE p.id = ANY($1::uuid[]) AND p.pdf_document_id IS NULL`,
        [packIds]
      ).then((rows) => {
        for (const r of rows) {
          out.push(
            issue(
              "DOCUMENT_MISSING",
              "danger",
              { type: "asbuilt_pack", id: String(r.id) },
              `Le dossier as-built version ${r.version ?? "?"} ne pointe aucun document.`
            )
          );
        }
      })
    );
  }

  await Promise.all(jobs);

  // Déduplication : un même code sur un même nœud ne se répète pas.
  const seen = new Set<string>();
  return out.filter((i) => {
    const key = `${i.code}|${i.node_id ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
