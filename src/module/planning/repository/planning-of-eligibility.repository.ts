import type { PoolClient } from "pg";
import { evaluateDossier, type DossierFacts, type DossierOperation } from "../../production/domain/of-dossier";

type EligibilityRow = {
  id: string; status: string; technical_readiness: string; technical_snapshot_sha256: string;
  revision: string; quantity: number; preparation_rules_version: number | null;
  operations: DossierOperation[];
  validation: { source_hash: string; invalidated_at: string | null; invalidation_reason: string | null } | null;
};

/** The preparation receipt, not the execution status or a forecast, releases an OF to planning.
 * Batch the same facts/hash as the production dossier before pagination (also for pinned tasks).
 * Legacy frozen OFs predate completion receipts; their validated definition remains authoritative.
 */
export async function readPlanningEligibleOfIds(tx: Pick<PoolClient, "query">, ids?: number[]): Promise<string[]> {
  const { rows } = await tx.query<EligibilityRow>(`
    SELECT o.id::text,o.statut::text AS status,o.technical_readiness,o.technical_snapshot_sha256,
      o.piece_technique_version_id::text AS revision,o.quantite_lancee::float8 AS quantity,o.preparation_rules_version,
      COALESCE(ops.operations,'[]'::jsonb) AS operations,validation.value AS validation
    FROM public.ordres_fabrication o
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',p.id::text,'phase',p.phase,'label',p.designation,
        'status',p.status::text,'setup',p.tp::float8,'unit',p.tf_unit::float8,'base',p.qte::float8,
        'coefficient',p.coef::float8,'planned',false,'start',NULL,'end',NULL,'resource',NULL)) AS operations
      FROM public.of_operations p WHERE p.of_id=o.id AND (p.revision_id IS NULL OR EXISTS(
        SELECT 1 FROM public.of_revisions r WHERE r.id=p.revision_id AND r.statut='ACTIVE'))
    ) ops ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('source_hash',v.source_hash,'invalidated_at',v.invalidated_at::text,
        'invalidation_reason',v.invalidation_reason) AS value
      FROM public.of_dossier_validations v WHERE v.of_id=o.id ORDER BY v.decided_at DESC,v.id DESC LIMIT 1
    ) validation ON true
    WHERE o.statut<>'ANNULE' AND o.technical_readiness='VALIDATED'
      AND o.technical_snapshot_sha256 IS NOT NULL AND o.piece_technique_version_id IS NOT NULL
      AND ($1::bigint[] IS NULL OR o.id=ANY($1::bigint[]))`, [ids ?? null]);
  return rows.filter(row => {
    if (!row.operations.length) return false;
    const facts: DossierFacts = {
      id: Number(row.id), status: row.status, technicalReadiness: row.technical_readiness,
      technicalHash: row.technical_snapshot_sha256, revision: row.revision,
      quantity: row.quantity, operations: row.operations,
    };
    if ((row.preparation_rules_version ?? 0) < 2 && !row.validation) return true;
    return evaluateDossier(facts, row.validation).status === "COMPLETE";
  }).map(row => row.id);
}
