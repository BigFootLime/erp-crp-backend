import type { PoolClient } from 'pg';
import { repoInsertAuditLog } from '../audit-logs/repository/audit-logs.repository';
import { readSubcontractFlows } from './subcontract-flow.repository';
import { completedSubcontractEvidence } from './subcontract-operation-completion';
import { assertReceiptLotQualityEligibility } from '../qualite/repository/quality-operational-gate.repository';

type Db = Pick<PoolClient, 'query'>;

/** Caller owns the transaction and planning revision lock. Only the complete,
 * conforming, transferred population can finish automatically here. Local
 * declarations are never created, replaced, or silently counted twice. */
export async function syncClosedSubcontractOperationTx(tx: Db, operationId: string, actor: number) {
  const operation = (await tx.query<{status:string;active:boolean;kind:string|null;target:number}>(`
    SELECT op.status::text AS status,o.quantite_lancee::float8 AS target,
      (o.statut::text NOT IN('ANNULE','CLOTURE') AND
        (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))) AS active,
      frozen.value->>'type_operation' AS kind
    FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id
    LEFT JOIN LATERAL(SELECT value FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]'::jsonb))
      WHERE value->>'phase'=op.phase::text LIMIT 1) frozen ON true
    WHERE op.id=$1::uuid FOR UPDATE OF op,o`,[operationId])).rows[0];
  if (!operation || !operation.active || operation.kind !== 'SOUS_TRAITANCE' || ['CANCELLED','BLOCKED'].includes(operation.status)) return false;
  if ((await tx.query('SELECT 1 FROM public.subcontract_operation_completions WHERE operation_id=$1::uuid',[operationId])).rows.length) return false;
  // Even compensated legacy declarations need explicit review; don't rewrite history.
  if ((await tx.query('SELECT 1 FROM public.production_quantity_declarations WHERE operation_id=$1::uuid LIMIT 1',[operationId])).rows.length) return false;
  if ((await tx.query(`SELECT 1 FROM public.subcontract_work_packages p
      WHERE p.of_operation_id=$1::uuid AND p.status='CANCELLED' AND EXISTS(
        SELECT 1 FROM public.subcontract_work_package_ledger e WHERE e.package_id=p.id) LIMIT 1`,[operationId])).rows.length) return false;
  const evidence = completedSubcontractEvidence(operation.target,await readSubcontractFlows(tx,[operationId]));
  if (!evidence) return false;
  // Lock the current receipt decisions as well as the operation. A newer hold
  // must not race between the projection above and recording the proof.
  for (const returned of [...evidence.returns].sort((a,b)=>a.lotId.localeCompare(b.lotId))) {
    await assertReceiptLotQualityEligibility({client:tx,lotId:returned.lotId,
      receiptLineId:returned.receiptLineId!,qty:returned.quantity,unit:evidence.unit});
  }
  const end = (await tx.query<{at:string}>(`SELECT max(closed_at)::text AS at FROM public.subcontract_work_packages
    WHERE id=ANY($1::uuid[])`,[evidence.packageIds])).rows[0]?.at;
  if (!end || !evidence.departedAt) return false;
  const saved = (await tx.query(`INSERT INTO public.subcontract_operation_completions
      (operation_id,qty_good,unit,started_at,ended_at,recorded_by,evidence)
    VALUES($1::uuid,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7::jsonb)
    ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`,
    [operationId,evidence.quantity,evidence.unit,evidence.departedAt,end,actor,JSON.stringify(evidence)])).rows[0];
  if (!saved) return false;
  await tx.query(`UPDATE public.of_operations SET status='DONE'::public.of_operation_status,
    started_at=COALESCE(started_at,$2::timestamptz),ended_at=COALESCE(ended_at,$3::timestamptz),updated_at=now()
    WHERE id=$1::uuid`,[operationId,evidence.departedAt,end]);
  await repoInsertAuditLog({tx,user_id:actor,ip:null,user_agent:null,device_type:null,os:null,browser:null,
    body:{event_type:'ACTION',action:'SUBCONTRACT_OPERATION_COMPLETED',page_key:'subcontract',
      entity_type:'OF_OPERATION',entity_id:operationId,details:evidence}});
  return true;
}
