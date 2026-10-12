import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { readUrgencyRestitutionTx } from './urgency-restitution-preview.repository';

type Db = Pick<PoolClient, 'query'>;
export type CancellationOf = {
  id: number; numero: string; statut: string; technical_snapshot_sha256: string | null;
  updated_at: string; operations: unknown[]; material_needs: unknown[]; reservations: unknown[];
  component_uses: unknown[]; groupings: unknown[]; events: unknown[];
};
export const cancellationOfEngaged = (of: CancellationOf) => !['BROUILLON', 'ANNULE'].includes(of.statut)
  || Boolean(of.technical_snapshot_sha256) || [of.operations, of.material_needs, of.reservations,
    of.component_uses, of.groupings, of.events].some(items => items.length > 0);

/** The review is separate from approval: cancellation must remain accessible when
 * supply, quality or the original planning proposal is no longer feasible. */
export async function readUrgencyCancellationTx(tx: Db, requestId: string) {
  const request = (await tx.query<{ id: string; beneficiary_allocation_id: number; status: string; version: number;
    approved_id: string | null; withdrawn_id: string | null; commande_id: number }>(`SELECT request.id::text,
      request.beneficiary_allocation_id::int,request.status,request.version,request.approved_id::text,request.withdrawn_id::text,
      allocation.commande_id::int FROM public.delivery_urgency_requests request
      JOIN public.commande_ligne_affaire_allocation allocation ON allocation.id=request.beneficiary_allocation_id
      WHERE request.id=$1::uuid`, [requestId])).rows[0];
  if (!request) throw new HttpError(404, 'URGENCY_REQUEST_NOT_FOUND', 'Demande urgente introuvable.');
  const roots = (await tx.query<{ recovery_of_id: number }>(`SELECT recovery_of_id::int
    FROM public.delivery_urgency_recoveries WHERE request_id=$1::uuid ORDER BY recovery_of_id`, [requestId])).rows.map(r => r.recovery_of_id);
  const tree = (await tx.query<CancellationOf>(`SELECT of.id::int,of.numero,of.statut::text,of.technical_snapshot_sha256,of.updated_at::text,
    COALESCE((SELECT jsonb_agg(to_jsonb(op) ORDER BY op.id) FROM public.of_operations op WHERE op.of_id=of.id),'[]') AS operations,
    COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.id) FROM public.of_material_needs n WHERE n.of_id=of.id),'[]') AS material_needs,
    COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.stock_reservations r WHERE r.status IN ('ACTIVE','CONSUMED')
      AND (r.of_id=of.id OR r.of_component_requirement_id IN
        (SELECT id FROM public.of_component_requirements WHERE consuming_of_id=of.id))),'[]') AS reservations,
    COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.of_component_requirements c
      WHERE c.component_of_id=of.id AND c.status<>'CANCELLED' AND NOT(c.consuming_of_id=ANY($1::bigint[]))
        AND NOT EXISTS(SELECT 1 FROM public.ordres_fabrication parent WHERE parent.id=c.consuming_of_id AND parent.root_of_id=ANY($1::bigint[]))),'[]') AS component_uses,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('allocation',to_jsonb(a),'grouping',to_jsonb(g),'producer',to_jsonb(p)) ORDER BY a.id)
      FROM public.production_consolidation_allocations a JOIN public.production_consolidations g ON g.id=a.consolidation_id
      JOIN public.ordres_fabrication p ON p.id=g.producer_of_id
      WHERE a.source_of_id=of.id AND a.state='ACTIVE' AND g.state='ACTIVE'),'[]') AS groupings,
    COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.planning_events e
      WHERE e.of_id=of.id AND e.archived_at IS NULL AND e.status<>'CANCELLED'),'[]') AS events
    FROM public.ordres_fabrication of WHERE of.id=ANY($1::bigint[]) OR of.root_of_id=ANY($1::bigint[]) ORDER BY of.id`, [roots])).rows;
  const issues: Array<{ code: string; message: string }> = [];
  if (!roots.length || roots.some(id => !tree.some(of => of.id === id)))
    issues.push({ code: 'URGENCY_RECOVERY_MISSING', message: 'Un OF de récupération manque. Faites vérifier le dossier.' });
  if (request.withdrawn_id || request.status === 'WITHDRAWN') issues.push({ code: 'URGENCY_ALREADY_WITHDRAWN',
    message: 'Les pièces ont déjà été prélevées. Réconciliez leur retour ou leur livraison avant d’annuler ; la récupération reste due au donneur.' });
  if (!['WAITING_PLANNER', 'APPROVED', 'WITHDRAWN'].includes(request.status))
    issues.push({ code: 'URGENCY_REQUEST_CLOSED', message: 'Cette demande est déjà annulée.' });
  const restitution = request.status === 'WITHDRAWN' ? await readUrgencyRestitutionTx(tx, requestId) : null;
  const engaged = tree.some(cancellationOfEngaged);
  const preview_hash = createHash('sha256').update(JSON.stringify({ request, roots, tree,
    ...(restitution ? { restitution: restitution.evidence } : {}) })).digest('hex');
  return { request, roots, tree, response: { request_id: request.id, request_version: request.version, status: request.status,
    preview_hash, can_cancel: !issues.length, requires_planner: engaged || request.status === 'APPROVED',
    production_retained: engaged, issues, restitution: restitution?.response ?? null,
    recoveries: tree.map(of => ({ of_id: of.id, of_numero: of.numero, of_status: of.statut,
      engaged: cancellationOfEngaged(of), grouped: of.groupings.length > 0 })),
  } };
}

export async function previewUrgencyCancellation(requestId: string) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { response } = await readUrgencyCancellationTx(tx, requestId);
    await tx.query('COMMIT'); return response;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}
