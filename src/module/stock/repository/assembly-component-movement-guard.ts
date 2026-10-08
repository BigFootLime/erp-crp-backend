import type { PoolClient } from 'pg';

export async function assemblyComponentWithdrawalOwnsMovement(db: Pick<PoolClient, 'query'>, movementId: string) {
  return (await db.query(`SELECT 1 FROM public.stock_command_receipts
    WHERE command_type='RESERVATION_CONSUME' AND resource_type='stock_reservation'
      AND request_payload->>'kind'='COMPONENT' AND result_payload->>'stockMovementId'=$1 LIMIT 1`, [movementId])).rows.length > 0;
}
