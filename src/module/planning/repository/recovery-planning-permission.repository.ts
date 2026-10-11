import type { PoolClient } from 'pg';
/** A new recovery belongs to an existing donor order whose AR is already sent.
 * Planning that dedicated tree does not revise the donor's original OF or promise. */
export async function isPendingRecoveryPlanningTx(tx: Pick<PoolClient, 'query'>, ofId: number | null): Promise<boolean> {
    if (ofId === null)
        return false;
    const result = await tx.query<{
        allowed: boolean;
    }>(`
    SELECT true AS allowed FROM public.ordres_fabrication producer
    JOIN public.delivery_urgency_recoveries recovery ON recovery.recovery_of_id=COALESCE(producer.root_of_id,producer.id)
    JOIN public.delivery_urgency_requests request ON request.id=recovery.request_id
    WHERE producer.id=$1 AND request.status IN ('WAITING_PLANNER','APPROVED')
      AND producer.statut::text NOT IN ('ANNULE','TERMINE','SOLDE')
    FOR SHARE OF request`, [ofId]);
    return result.rows[0]?.allowed === true;
}
