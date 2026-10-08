import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { assertOperationalLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';
import { beginStockCommand, completeStockCommand } from '../../stock/repository/stock.repository';
import { consumeComponentReservationTx } from '../../stock/repository/partial-reservation-consumption.repository';
import { planAssemblyComponentConsumption } from '../domain/assembly-component-consumption';
import { materialPropertiesFingerprint } from '../domain/of-material';
import { readOfComponentCoverageTx } from './of-component-coverage.repository';
import { OF_ASSEMBLY_OPERATIONS_SQL } from './of-component-coverage.sql';
import { readOfDossierTx } from './of-dossier.repository';
import { preparationAudit } from './production-preparation.repository';
import type { AuditContext } from './production.repository';
import type { AssemblyComponentWithdrawal } from '../validators/assembly-component-consumption.validators';

type Db = Pick<PoolClient, 'query'>;
type AssemblyOperation = { id: string; phase: number; label: string; status: string };

async function preparation(tx: Db, ofId: number, quantity?: number) {
  const coverage = await readOfComponentCoverageTx(tx, ofId, true);
  const operations = (await tx.query<AssemblyOperation>(OF_ASSEMBLY_OPERATIONS_SQL, [ofId])).rows;
  const dossier = await readOfDossierTx(tx, ofId);
  const operation = operations[0] ?? null;
  let plan: ReturnType<typeof planAssemblyComponentConsumption> | null = null;
  const blockers: Array<{ code: string; message: string }> = [];
  if (!operation) blockers.push({ code: 'ASSEMBLY_OPERATION_REQUIRED', message: 'Le dossier doit contenir une opération de montage.' });
  if (dossier.status !== 'COMPLETE') blockers.push({ code: 'OF_DOSSIER_INCOMPLETE', message: 'Complétez le dossier de fabrication.' });
  if (['TERMINE', 'CLOTURE', 'ANNULE'].includes(coverage.executionStatus)
    || (operation && ['DONE', 'BLOCKED', 'CANCELLED'].includes(operation.status))) {
    blockers.push({ code: 'ASSEMBLY_OPERATION_CLOSED', message: 'Cet OF ou cette opération n’accepte plus de sortie de composants.' });
  }
  if (operation && !dossier.operations.some(item => item.id === operation.id && (item.planned || item.status === 'RUNNING'))) {
    blockers.push({ code: 'ASSEMBLY_PLANNING_REQUIRED', message: 'Planifiez l’opération de montage.' });
  }
  try { plan = planAssemblyComponentConsumption(coverage, quantity); }
  catch (error) {
    if (!(error instanceof HttpError)) throw error;
    blockers.push({ code: error.code, message: error.message });
  }
  const version = materialPropertiesFingerprint({ coverage: coverage.version, operations, dossier: {
    status: dossier.status, operations: dossier.operations.map(item => ({ id: item.id, status: item.status, planned: item.planned })),
  } });
  return { ofId, number: coverage.number, operation, version, plan, canWithdraw: !blockers.length && plan !== null, blockers, coverage };
}

export async function getAssemblyComponentPreparation(ofId: number, quantity?: number) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await preparation(tx, ofId, quantity);
    await tx.query('COMMIT');
    return result;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}

/** Intake is a physical command, distinct from time, good output or rework.
 * The immutable stock receipts retain every partial requirement/lot issue. */
export async function withdrawAssemblyComponents(ofId: number, body: AssemblyComponentWithdrawal, audit: AuditContext) {
  return withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
    await tx.query('SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE', [ofId]);
    const command = await beginStockCommand(tx, { audit, idempotency_key: body.idempotencyKey,
      command_type: 'RESERVATION_CONSUME', request_payload: { ofId, kind: 'ASSEMBLY_COMPONENTS', ...body } });
    if (command.existing) return command.existing.result_payload;
    const coverage = await readOfComponentCoverageTx(tx, ofId, true);
    // Same global order as material debit: planning, OF, all source lots, stock.
    for (const lotId of [...new Set(coverage.items.flatMap(item => item.lots.flatMap(lot => lot.lotId ? [lot.lotId] : [])))].sort()) {
      await assertOperationalLotQualityEligibility({ client: tx, lotId, qty: 0, purpose: 'RESERVE' });
    }
    const current = await preparation(tx, ofId, body.quantity);
    if (body.expectedVersion !== current.version) throw new HttpError(409, 'ASSEMBLY_PREPARATION_CHANGED', 'Les composants ou le planning ont changé. Relisez la sortie proposée.');
    if (body.operationId !== current.operation?.id) throw new HttpError(409, 'ASSEMBLY_OPERATION_CHANGED', 'La sortie appartient à la première opération de montage du dossier figé.');
    if (!current.canWithdraw || !current.plan) throw new HttpError(409, 'ASSEMBLY_COMPONENTS_NOT_READY', 'La sortie de composants n’est pas prête.', { blockers: current.blockers });
    const movements: Array<{ requirementId: string; sourceOfId: number; reservationId: string; stockMovementId: string; quantity: number }> = [];
    for (const allocation of current.plan.allocations) {
      const result = await consumeComponentReservationTx(tx, {
        reservationId: allocation.reservationId, requirementId: allocation.requirementId, ofId,
        operationId: body.operationId, quantity: allocation.quantity, expectedVersion: allocation.reservationVersion,
        idempotencyKey: `${body.idempotencyKey}:${allocation.reservationId}`,
        reason: `Mise en montage : ${current.plan.quantity} pièce(s), phase ${current.operation.phase}.`,
      }, audit);
      movements.push({ requirementId: allocation.requirementId, sourceOfId: allocation.sourceOfId,
        reservationId: result.reservationId, stockMovementId: result.stockMovementId, quantity: result.quantity });
    }
    const result = { ofId, operationId: body.operationId, assemblyQuantity: current.plan.quantity,
      sourceAllocations: current.plan.sourceAllocations, remaining: current.plan.remainingAfter, movements };
    await completeStockCommand(tx, { audit, command, command_type: 'RESERVATION_CONSUME',
      resource_type: 'ordres_fabrication', resource_id: String(ofId), result_payload: result });
    await preparationAudit(tx, audit, ofId, 'production.of.assembly-component-withdrawal', result);
    return result;
  });
}
