import type { PoolClient } from 'pg';
/** Covers every partial withdrawal, including those preceding the latest
 * movement referenced on the reservation row. */
export async function consumableWithdrawalOwnsMovement(db:Pick<PoolClient,'query'>,movementId:string){
  return (await db.query(`SELECT 1 FROM public.consumable_commands
    WHERE command_type='WITHDRAW' AND response->>'stockMovementId'=$1 LIMIT 1`,[movementId])).rows.length>0;
}
