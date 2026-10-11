import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { readOperationReadinessTx, usesOperationReadiness } from "../../production/repository/operation-readiness.repository";
import type { ExecutionPreviewBodyDTO } from "../validators/quality-360.validators";

type Db = Pick<PoolClient, "query">;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type QualityOfIdentity = {
  id: number; numero: string; status: string; population: number; unit: string;
  article_id: string | null; piece_id: string; version_id: string | null; famille_id: string | null;
  snapshot_sha256: string | null; operation_id: string | null; phase: number | null; label: string | null;
  operation_status: string | null;
};

export function isOfQualitySource(body: Pick<ExecutionPreviewBodyDTO, "source_type">) {
  return body.source_type === "OF" || body.source_type === "OF_OPERATION";
}

/** Resolve an operation against its owning OF before using any client context. */
export async function readQualityOfIdentity(q: Db, ofId: number, operationId: string | null, lock = false): Promise<QualityOfIdentity> {
  if (operationId && !uuidPattern.test(operationId)) throw new HttpError(422, "QUALITY_OF_OPERATION_INVALID", "Opération invalide.");
  if (lock) await q.query("SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE", [ofId]);
  const row = (await q.query<QualityOfIdentity>(`
    SELECT o.id::bigint::int AS id,o.numero,o.statut::text AS status,o.quantite_lancee::float8 AS population,
      COALESCE(NULLIF(btrim(a.unite),''),'u') AS unit,o.article_id::text,o.piece_technique_id::text AS piece_id,
      o.piece_technique_version_id::text AS version_id,p.famille_id::text,o.technical_snapshot_sha256 AS snapshot_sha256,
      op.id::text AS operation_id,op.phase,op.designation AS label,op.status::text AS operation_status
    FROM public.ordres_fabrication o LEFT JOIN public.articles a ON a.id=o.article_id
      JOIN public.pieces_techniques p ON p.id=o.piece_technique_id
      LEFT JOIN public.of_operations op ON op.of_id=o.id AND op.id=$2::uuid
        AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))
    WHERE o.id=$1`, [ofId, operationId])).rows[0];
  if (!row) throw new HttpError(404, "QUALITY_OF_NOT_FOUND", "OF introuvable.");
  if (operationId && row.operation_id !== operationId) throw new HttpError(409, "QUALITY_OF_OPERATION_MISMATCH", "Cette opération n'appartient pas à la gamme active de cet OF.");
  if (row.status === "ANNULE" || row.operation_status === "CANCELLED") throw new HttpError(409, "QUALITY_OF_CANCELLED", "Cet OF ou cette opération est annulé.");
  if (!row.snapshot_sha256) throw new HttpError(409, "QUALITY_OF_NOT_FROZEN", "Validez le dossier technique de cet OF avant de préparer son contrôle.");
  if (lock && operationId) await q.query("SELECT id FROM public.of_operations WHERE id=$1::uuid FOR UPDATE", [operationId]);
  return row;
}

/** Physical ceiling includes units already declared on this operation, so a
 * repeat inspection does not disappear when the time/quantity entry ends. */
export async function qualityOfPopulationCeiling(q: Db, identity: QualityOfIdentity) {
  if (!identity.operation_id) return identity.population;
  if (await usesOperationReadiness(q, identity.id)) {
    const readiness = await readOperationReadinessTx(q, identity.id);
    const op = readiness.operations.find(item => item.id === identity.operation_id);
    if (!op) throw new HttpError(409, "QUALITY_OF_OPERATION_MISMATCH", "Cette opération n'appartient plus à cet OF.");
    return Math.min(identity.population, op.availableQuantity + op.processedQuantity);
  }
  // Compatibility for a frozen historical OF without the material workbench.
  const row = (await q.query<{ population: number }>(`WITH previous AS (SELECT id FROM public.of_operations
      WHERE of_id=$1 AND phase<$2 AND status<>'CANCELLED'
        AND (revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=revision_id AND r.statut='ACTIVE'))
      ORDER BY phase DESC,id DESC LIMIT 1)
    SELECT CASE WHEN EXISTS(SELECT 1 FROM previous) THEN (SELECT COALESCE(sum(d.qty_good),0)
      FROM public.production_quantity_declarations d WHERE d.operation_id=(SELECT id FROM previous)) ELSE $3 END::float8 AS population`,
    [identity.id, identity.phase, identity.population])).rows[0];
  return Math.min(identity.population, Number(row?.population ?? 0));
}

/** A late READY self-inspection sheet pins a plan just as the initial freeze
 * does. A published newer revision is never an implicit replacement. */
export async function readFrozenQualityPlanId(q: Db, ofId: number, operationId: string | null, trigger: string | null): Promise<string | null> {
  const row = (await q.query<{ plan_id: string | null }>(`SELECT COALESCE(
      (SELECT p.id::text FROM public.quality_control_plan p
        WHERE p.id::text=o.technical_snapshot->'preparation_evidence'->'quality_plan'->>'id' AND ($2::text IS NULL OR p.trigger_type=$2)),
      CASE WHEN EXISTS(SELECT 1 FROM public.of_self_inspection_sheets s
        WHERE s.id::text=o.technical_preparation->>'self_inspection_sheet_id' AND s.of_id=o.id AND s.state='READY'
          AND s.piece_technique_version_id=o.piece_technique_version_id
          AND s.quality_plan_id::text=o.technical_preparation->'execution_quality'->'quality_plan'->>'id'
          AND (s.snapshot->'of'->>'quantite_lancee')::numeric=o.quantite_lancee)
        THEN (SELECT p.id::text FROM public.quality_control_plan p
          WHERE p.id::text=o.technical_preparation->'execution_quality'->'quality_plan'->>'id' AND ($2::text IS NULL OR p.trigger_type=$2)) END,
      (SELECT c.plan_id::text FROM public.quality_control c WHERE c.of_id=o.id AND c.plan_id IS NOT NULL
        AND ($2::text IS NULL OR c.trigger_type=$2) AND ($3::uuid IS NULL OR c.operation_id=$3 OR c.source_type='OF_OPERATION' AND c.source_id=$3::text)
        ORDER BY c.control_date,c.id LIMIT 1)) AS plan_id
    FROM public.ordres_fabrication o WHERE o.id=$1`, [ofId, trigger, operationId])).rows[0];
  return row?.plan_id ?? null;
}

export async function resolveQualityOfContext<T extends ExecutionPreviewBodyDTO>(q: Db, body: T, lock = false): Promise<T> {
  if (!isOfQualitySource(body)) {
    if (body.operation_id) throw new HttpError(422, "QUALITY_OF_SCOPE_INVALID", "L'opération est réservée au contrôle d'un OF.");
    return body;
  }
  let ofId = body.of_id;
  const operationId = body.source_type === "OF_OPERATION" ? body.source_id : null;
  if (operationId && !uuidPattern.test(operationId)) throw new HttpError(422, "QUALITY_OF_OPERATION_INVALID", "Opération invalide.");
  if (body.operation_id && body.operation_id !== operationId) throw new HttpError(409, "QUALITY_OF_OPERATION_MISMATCH", "L'opération doit correspondre à la source du contrôle.");
  if (!ofId && operationId) ofId = Number((await q.query<{ of_id: number }>("SELECT of_id::bigint::int FROM public.of_operations WHERE id=$1::uuid", [operationId])).rows[0]?.of_id);
  if (!ofId && body.source_type === "OF" && /^\d+$/.test(body.source_id)) ofId = Number(body.source_id);
  if (!Number.isSafeInteger(ofId) || Number(ofId) <= 0) throw new HttpError(422, "QUALITY_OF_REQUIRED", "Choisissez l'OF à contrôler.");
  const identity = await readQualityOfIdentity(q, Number(ofId), operationId, lock);
  if (body.source_type === "OF" && body.source_id !== String(identity.id) && body.source_id !== identity.numero) throw new HttpError(409, "QUALITY_OF_SCOPE_CHANGED", "La source du contrôle ne correspond pas à cet OF.");
  if (body.lot_id || body.reception_ligne_id || body.bon_livraison_id || body.delivery_allocation_id || body.fournisseur_id) throw new HttpError(422, "QUALITY_OF_SCOPE_INVALID", "Le contrôle d'opération ne doit pas mélanger une réception ou une livraison.");
  const known = { article_id: identity.article_id, piece_technique_id: identity.piece_id, piece_version_id: identity.version_id, famille_id: identity.famille_id, operation_code: identity.phase === null ? null : String(identity.phase) };
  for (const key of Object.keys(known) as Array<keyof typeof known>) {
    if (body[key] && body[key] !== known[key]) throw new HttpError(409, "QUALITY_OF_SCOPE_CHANGED", "Les données du contrôle ne correspondent plus à cet OF.", { field: key });
  }
  if (body.unite.trim().toUpperCase() !== identity.unit.trim().toUpperCase()) throw new HttpError(409, "QUALITY_OF_UNIT_MISMATCH", "Utilisez l'unité de fabrication de cet OF.", { unit: identity.unit });
  const ceiling = await qualityOfPopulationCeiling(q, identity);
  if (!(body.population > 0) || body.population > ceiling + 1e-9) throw new HttpError(409, "QUALITY_OF_POPULATION_UNAVAILABLE", "La quantité à contrôler dépasse les pièces disponibles sur cette opération.", { population: ceiling, unit: identity.unit });
  return { ...body, ...known, of_id: identity.id, operation_id: identity.operation_id, unite: identity.unit };
}
