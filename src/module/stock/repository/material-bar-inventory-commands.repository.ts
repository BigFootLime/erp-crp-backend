import pool from '../../../config/database';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import { beginStockCommand, completeStockCommand, type AuditContext } from './stock.repository';
import { assertMaterialBarSchema, lockMaterialBarInventoryTx, readMaterialBarInventoryTx, writeMaterialBarInventoryTx, type MaterialBarInventory } from './material-bar-inventory.repository';
import type { MaterialBarInventoryCommand } from '../validators/material-bars.validators';
import { HttpError } from '../../../utils/httpError';

export async function readMaterialBarInventory(batchId: string) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assertMaterialBarSchema(tx);
    const result = await readMaterialBarInventoryTx(tx, batchId);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally { tx.release(); }
}

export async function confirmMaterialBarInventory(batchId: string, body: MaterialBarInventoryCommand, audit: AuditContext) {
  return withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    await assertMaterialBarSchema(tx);
    const command = await beginStockCommand(tx, { audit, idempotency_key: body.idempotencyKey,
      command_type: 'INVENTORY_COUNT', request_payload: { physical_bars: { batchId, ...body } } });
    if (command.existing) return { inventory: command.existing.result_payload.inventory as MaterialBarInventory, replayed: true };
    const current = await lockMaterialBarInventoryTx(tx, batchId);
    const inventory = await writeMaterialBarInventoryTx(tx, current, body, audit.user_id, command.correlation_id);
    if (inventory.status !== 'CONFIRMED')
      throw new HttpError(409, 'MATERIAL_BAR_INVENTORY_CHANGED', inventory.warning ?? 'Le comptage ne correspond plus au stock.');
    await repoInsertAuditLog({ user_id: audit.user_id, tx, ip: audit.ip, user_agent: audit.user_agent,
      device_type: audit.device_type, os: audit.os, browser: audit.browser,
      body: { event_type: 'ACTION', action: 'stock.material-bars.confirm', page_key: audit.page_key ?? 'stock',
        entity_type: 'stock_material_bar_inventory', entity_id: batchId,
        details: { previousRevision: current.revision, revision: inventory.revision, barCount: inventory.bars.length,
          physicalMm: inventory.batch.physicalMm, reservedMm: inventory.batch.reservedMm, reason: body.reason } } });
    await completeStockCommand(tx, { audit, command, command_type: 'INVENTORY_COUNT',
      resource_type: 'stock_material_bar_inventory', resource_id: batchId, result_payload: { inventory } });
    return { inventory, replayed: false };
  });
}
