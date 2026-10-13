import type {PoolClient} from 'pg';
export type RecoveryProducer={recovery_id:string;source_of_id:number;producer_of_id:number;grouped:boolean;valid:boolean;addition_id:string|null};
/** Commercial recovery identity stays on its source OF; physical operations and
 * supplies belong to the active producer. A completed addition is the only
 * permission to approve an already running group for a pending urgency. */
export async function readUrgencyRecoveryProducersTx(tx:Pick<PoolClient,'query'>,recoveryIds:string[]) {
  return (await tx.query<RecoveryProducer>(`SELECT recovery.id::text AS recovery_id,source.id::int AS source_of_id,
    COALESCE(producer.id,source.id)::int AS producer_of_id,(grouping.id IS NOT NULL) AS grouped,
    addition.id::text AS addition_id,
    (grouping.id IS NULL OR (allocation.quantity=recovery.quantity AND source.quantite_lancee=recovery.quantity
      AND producer.client_id IS NOT NULL AND producer.client_id=source.client_id AND producer.article_id=source.article_id
      AND producer.piece_technique_id=source.piece_technique_id AND producer.piece_technique_version_id=source.piece_technique_version_id
      AND producer.technical_snapshot_sha256=source.technical_snapshot_sha256
      AND NOT EXISTS(SELECT 1 FROM public.production_consolidation_allocations other
        JOIN public.ordres_fabrication other_source ON other_source.id=other.source_of_id
        WHERE other.consolidation_id=grouping.id AND other.state='ACTIVE' AND other_source.client_id IS DISTINCT FROM source.client_id))) AS valid
    FROM public.delivery_urgency_recoveries recovery JOIN public.ordres_fabrication source ON source.id=recovery.recovery_of_id
    LEFT JOIN public.production_consolidation_allocations allocation ON allocation.source_of_id=source.id AND allocation.state='ACTIVE'
    LEFT JOIN public.production_consolidations grouping ON grouping.id=allocation.consolidation_id AND grouping.state='ACTIVE'
    LEFT JOIN public.ordres_fabrication producer ON producer.id=grouping.producer_of_id
    LEFT JOIN public.production_recovery_consolidation_additions addition ON addition.recovery_id=recovery.id
      AND addition.consolidation_id=grouping.id AND addition.producer_of_id=producer.id AND addition.allocation_id=allocation.id
    WHERE recovery.id=ANY($1::uuid[]) ORDER BY recovery.id`,[recoveryIds])).rows;
}
