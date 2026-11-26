import type { PoolClient } from "pg";
import { programmingPreparationCurrent, type ProgrammingPreparation } from "../domain/operation-programming";
import { sourceHash, type PreparationDecisions } from "../domain/preparation-rules";
import type { PreparationOrder } from "./production-preparation.repository";

export type StockReview = {
  source_hash: string;
  decision: string;
  reason: string;
  inherited_from_of_id?: number;
};

export type PreviousPreparation = {
  id: number;
  quantite_lancee: number;
  operations: Array<{ id: string }>;
  programming: Record<string, ProgrammingPreparation>;
  global_programming: PreparationDecisions["programming"] | null;
  stock_review: StockReview | null;
};

type Operation = { id: string };
const OPERATION_METADATA = new Set(["id", "gamme_id", "created_at", "created_by", "updated_at", "updated_by"]);

// A copy of a gamme keeps the operation's lineage. Ignore only row identity
// and audit metadata when comparing its manufacturing definition.
function operationDefinition(operation: Operation) {
  return sourceHash(Object.fromEntries(Object.entries(operation).filter(([key]) => !OPERATION_METADATA.has(key))));
}

export async function inheritOperationProgramming(
  tx: Pick<PoolClient, "query">,
  of: PreparationOrder,
  previous: PreviousPreparation,
  operations: readonly Operation[],
) {
  const candidates = operations.filter(op => !of.technical_preparation?.operation_programming?.[op.id]);
  const prepared = previous.operations.filter(op => programmingPreparationCurrent(op, of.version_id, previous.programming[op.id]));
  const inherited: Record<string, ProgrammingPreparation> = {};
  if (!candidates.length || !prepared.length) return inherited;
  const { rows } = await tx.query<{ id: string; lineage: string }>(
    `SELECT op.id::text, COALESCE(op.gamme_source_operation_id,op.id)::text AS lineage
      FROM public.pieces_techniques_operations op JOIN public.gammes g ON g.id=op.gamme_id
      WHERE g.piece_technique_version_id=$1::uuid AND op.id=ANY($2::uuid[])`,
    [of.version_id, [...candidates, ...prepared].map(op => op.id)],
  );
  const lineage = new Map(rows.map(row => [row.id, row.lineage]));
  for (const op of candidates) {
    const prior = prepared.find(candidate => (candidate.id === op.id
      || (lineage.has(op.id) && lineage.get(op.id) === lineage.get(candidate.id)))
      && operationDefinition(candidate) === operationDefinition(op));
    if (!prior) continue;
    const choice = previous.programming[prior.id];
    inherited[op.id] = {
      ...choice,
      operation_hash: sourceHash(op),
      inherited_from_of_id: choice.inherited_from_of_id ?? previous.id,
    };
  }
  return inherited;
}

export async function loadPreviousPreparation(
  tx: Pick<PoolClient, "query">,
  of: PreparationOrder,
): Promise<PreviousPreparation | null> {
  if (of.statut !== "BROUILLON" || of.technical_snapshot_sha256 || !of.version_id) return null;
  const { rows } = await tx.query<PreviousPreparation>(
    `SELECT p.id::int, p.quantite_lancee::float8,
      CASE WHEN jsonb_typeof(p.technical_snapshot#>'{preparation_evidence,operations}')='array'
        THEN p.technical_snapshot#>'{preparation_evidence,operations}' ELSE '[]'::jsonb END AS operations,
      COALESCE(p.technical_preparation->'operation_programming','{}'::jsonb) AS programming,
      COALESCE(p.technical_preparation->'execution_programming',p.technical_snapshot#>'{preparation_decisions,programming}') AS global_programming,
      CASE WHEN r.of_id IS NOT NULL THEN jsonb_build_object('source_hash',r.source_hash,'decision',r.decision,'reason',r.reason)
        || CASE WHEN r.source_hash=p.technical_preparation#>>'{inherited_stock_review,source_hash}'
          THEN jsonb_build_object('inherited_from_of_id',p.technical_preparation#>'{inherited_stock_review,inherited_from_of_id}')
          ELSE '{}'::jsonb END
        ELSE p.technical_preparation->'inherited_stock_review' END AS stock_review
    FROM public.ordres_fabrication p
    LEFT JOIN public.of_stock_reviews r ON r.of_id=p.id
    WHERE p.piece_technique_id=$1::uuid AND p.piece_technique_version_id=$2::uuid AND p.id<$3::bigint
      AND p.client_id IS NOT DISTINCT FROM $4 AND p.article_id IS NOT DISTINCT FROM $5::uuid
      AND p.technical_readiness='VALIDATED' AND p.technical_snapshot_sha256 IS NOT NULL AND p.statut<>'ANNULE'
    ORDER BY p.technical_validated_at DESC NULLS LAST,p.id DESC
    LIMIT 1`,
    [of.piece_technique_id, of.version_id, of.id, of.client_id, of.article_id],
  );
  return rows[0] ?? null;
}
