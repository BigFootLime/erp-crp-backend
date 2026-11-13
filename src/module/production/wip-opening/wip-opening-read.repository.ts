import type { PoolClient } from "pg";
import type { WipOpeningReadModel } from "./wip-opening.types";
/** Read-only opening facts consumed by the normal readiness projection. */
export async function readWipOpeningCheckpointsTx(tx: Pick<PoolClient, "query">, ofId: number): Promise<WipOpeningReadModel[]> {
  const installed = await tx.query<{ installed: boolean }>("SELECT to_regclass('public.data_cutover_wip_operation_checkpoints') IS NOT NULL AS installed");
  if (!installed.rows[0]?.installed) return [];
  const rows = await tx.query<{ operation_id: string; phase: number; status: WipOpeningReadModel["status"]; quantity_good: number; quantity_scrap: number; quantity_pending_control: number; unit: string }>(
    `SELECT checkpoint.of_operation_id::text AS operation_id,checkpoint.phase::int AS phase,checkpoint.checkpoint_status AS status,
            checkpoint.quantity_good::float8 AS quantity_good,checkpoint.quantity_scrap::float8 AS quantity_scrap,
            checkpoint.quantity_pending_control::float8 AS quantity_pending_control,checkpoint.unit
       FROM public.data_cutover_wip_operation_checkpoints checkpoint
       JOIN public.data_cutover_wip_resumptions resume ON resume.id=checkpoint.resumption_id
      WHERE resume.of_id=$1::bigint ORDER BY checkpoint.phase,checkpoint.id`, [ofId]
  );
  return rows.rows.map((row) => ({ operationId: row.operation_id, phase: row.phase, status: row.status, quantityGood: row.quantity_good, quantityScrap: row.quantity_scrap, quantityPendingControl: row.quantity_pending_control, unit: row.unit, origin: "CUTOVER_OPENING" }));
}

/** A completed opening checkpoint is an immutable historical fact, never a
 * native DONE status. Callers use it to refuse a second start without writing
 * a fabricated timestamp or pointage. */
export async function readWipOpeningCheckpointForOperationTx(
  tx: Pick<PoolClient, "query">,
  operationId: string
): Promise<WipOpeningReadModel | null> {
  const installed = await tx.query<{ installed: boolean }>("SELECT to_regclass('public.data_cutover_wip_operation_checkpoints') IS NOT NULL AS installed");
  if (!installed.rows[0]?.installed) return null;
  const row = (await tx.query<{ operation_id: string; phase: number; status: WipOpeningReadModel["status"]; quantity_good: number; quantity_scrap: number; quantity_pending_control: number; unit: string }>(
    `SELECT checkpoint.of_operation_id::text AS operation_id,checkpoint.phase::int AS phase,checkpoint.checkpoint_status AS status,
            checkpoint.quantity_good::float8 AS quantity_good,checkpoint.quantity_scrap::float8 AS quantity_scrap,
            checkpoint.quantity_pending_control::float8 AS quantity_pending_control,checkpoint.unit
       FROM public.data_cutover_wip_operation_checkpoints checkpoint
      WHERE checkpoint.of_operation_id=$1::uuid
      ORDER BY checkpoint.created_at,checkpoint.id LIMIT 1`, [operationId]
  )).rows[0];
  return row ? { operationId: row.operation_id, phase: row.phase, status: row.status, quantityGood: row.quantity_good, quantityScrap: row.quantity_scrap, quantityPendingControl: row.quantity_pending_control, unit: row.unit, origin: "CUTOVER_OPENING" } : null;
}
