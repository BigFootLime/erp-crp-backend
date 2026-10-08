import { z } from 'zod';
import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { assertOperationalLotQualityEligibility, readOperationalLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';
import { beginStockCommand, completeStockCommand } from '../../stock/repository/stock.repository';
import { returnAssemblyComponentTx } from '../../stock/repository/assembly-component-return.repository';
import { materialPropertiesFingerprint } from '../domain/of-material';
import { readOfComponentCoverageTx } from './of-component-coverage.repository';
import { OF_ASSEMBLY_OPERATIONS_SQL } from './of-component-coverage.sql';
import { ASSEMBLY_WITHDRAWALS_SQL, ASSEMBLY_RETURN_MOVEMENTS_SQL, ASSEMBLY_RETURN_DOWNSTREAM_SQL } from './assembly-component-return.sql';
import { preparationAudit } from './production-preparation.repository';
import type { AuditContext } from './production.repository';
import type { AssemblyComponentReturn } from '../validators/assembly-component-consumption.validators';

type Db = Pick<PoolClient, 'query'>;
const receiptResult = z.object({ ofId: z.number().int().positive(), operationId: z.string().uuid(),
  assemblyQuantity: z.number().int().positive(), sourceAllocations: z.array(z.object({ sourceOfId: z.number().int().positive(), assemblyQuantity: z.number().int().positive() })).nonempty(),
  movements: z.array(z.object({ requirementId: z.string().uuid(), sourceOfId: z.number().int().positive(),
    reservationId: z.string().uuid(), stockMovementId: z.string().uuid(), quantity: z.number().positive() })).nonempty() });
type Withdrawal = { id: string; createdAt: string; result: unknown; returned: boolean };
type ReturnMovement = { requirementId: string; sourceOfId: string; reservationId: string; stockMovementId: string;
  quantity: number; lotId: string | null; lotCode: string | null; label: string; reservationVersion: number;
  reservationStatus: string; consumed: number; unit: string | null; correctable: boolean | null };
type Operation = { id: string; phase: number; label: string; status: string };

async function readReturn(tx: Db, ofId: number, withdrawalId: string) {
  const records = (await tx.query<Withdrawal>(ASSEMBLY_WITHDRAWALS_SQL, [ofId, withdrawalId])).rows;
  if (!records.length) throw new HttpError(404, 'ASSEMBLY_WITHDRAWAL_NOT_FOUND', 'Mise en montage introuvable pour cet OF.');
  if (records.length !== 1) throw new HttpError(409, 'ASSEMBLY_WITHDRAWAL_AMBIGUOUS', 'La preuve de cette mise en montage doit être rapprochée.');
  const record = records[0], parsed = receiptResult.safeParse(record.result);
  if (!parsed.success || parsed.data.ofId !== ofId) throw new HttpError(409, 'ASSEMBLY_WITHDRAWAL_PROOF_REQUIRED', 'La preuve de sortie est incomplète. Faites rapprocher les composants.');
  const original = parsed.data;
  const coverage = await readOfComponentCoverageTx(tx, ofId, true);
  const operations = (await tx.query<Operation>(OF_ASSEMBLY_OPERATIONS_SQL, [ofId])).rows;
  const operation = operations[0] ?? null;
  const movements = (await tx.query<ReturnMovement>(ASSEMBLY_RETURN_MOVEMENTS_SQL, [ofId, withdrawalId])).rows;
  const downstream = (await tx.query<Record<string, boolean>>(ASSEMBLY_RETURN_DOWNSTREAM_SQL, [ofId, operation?.phase ?? 0])).rows[0];
  const blockers: Array<{ code: string; message: string }> = [];
  if (record.returned) blockers.push({ code: 'ASSEMBLY_WITHDRAWAL_ALREADY_RETURNED', message: 'Cette mise en montage est déjà restituée.' });
  if (coverage.coveredByOfId || operation?.id !== original.operationId || ['TERMINE', 'CLOTURE', 'ANNULE'].includes(coverage.executionStatus)
    || !operation || ['DONE', 'BLOCKED', 'CANCELLED'].includes(operation.status)) {
    blockers.push({ code: 'ASSEMBLY_RETURN_OPERATION_CHANGED', message: 'Le montage est clôturé ou son dossier a changé. Faites traiter sa correction par le responsable.' });
  }
  if (!downstream || Object.values(downstream).some(Boolean)) {
    blockers.push({ code: 'ASSEMBLY_RETURN_DOWNSTREAM_USED', message: 'Des quantités, un contrôle ou un transfert utilisent le montage. Traitez leur correction avant le retour.' });
  }
  const uniqueMovements = new Set(movements.map(item => item.stockMovementId));
  const originalById = new Map(original.movements.map(item => [item.stockMovementId, item]));
  const matches = movements.length === original.movements.length && uniqueMovements.size === movements.length
    && originalById.size === original.movements.length && movements.every(item => {
      const proof = originalById.get(item.stockMovementId);
      const requirement = coverage.items.find(need => need.id === item.requirementId);
      return item.correctable === true && item.lotId && proof && requirement
        && item.reservationId === proof.reservationId && item.requirementId === proof.requirementId
        && Number(item.sourceOfId) === proof.sourceOfId && requirement.sourceOfId === proof.sourceOfId
        && item.quantity === proof.quantity;
    });
  if (!matches) blockers.push({ code: 'ASSEMBLY_RETURN_STOCK_CHANGED', message: 'Une réservation, un lot ou sa preuve a changé. Faites vérifier les composants avant le retour.' });
  const quality = [];
  for (const lotId of [...new Set(movements.flatMap(item => item.lotId ? [item.lotId] : []))].sort()) {
    const state = await readOperationalLotQualityEligibility({ client: tx, lotId, qty: 0, purpose: 'RESERVE' });
    quality.push({ lotId, target: state.target, committed: state.already_committed_qty, eligibility: state.eligibility });
    for (const block of state.eligibility.blocks) blockers.push({ code: block.code, message: block.message });
  }
  const version = materialPropertiesFingerprint({ withdrawalId, returned: record.returned, original,
    coverage: coverage.version, operations, movements, downstream, quality });
  return { ofId, withdrawalId, createdAt: record.createdAt, assemblyQuantity: original.assemblyQuantity,
    sourceAllocations: original.sourceAllocations, operation, version, canReturn: !blockers.length, blockers,
    movements: movements.map(item => ({ requirementId: item.requirementId, sourceOfId: Number(item.sourceOfId),
      reservationId: item.reservationId, stockMovementId: item.stockMovementId, quantity: item.quantity,
      lotId: item.lotId, lotCode: item.lotCode, label: item.label, unit: item.unit })) };
}

async function readOnly<T>(run: (tx: PoolClient) => Promise<T>) {
  const tx = await pool.connect();
  try { await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); const result = await run(tx); await tx.query('COMMIT'); return result; }
  catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}

export function getAssemblyComponentReturn(ofId: number, withdrawalId: string) {
  return readOnly(tx => readReturn(tx, ofId, withdrawalId));
}
export function getAssemblyComponentWithdrawals(ofId: number) {
  return readOnly(async tx => {
    await readOfComponentCoverageTx(tx, ofId, true);
    const records = (await tx.query<Withdrawal>(ASSEMBLY_WITHDRAWALS_SQL, [ofId, null])).rows;
    return { ofId, items: records.map(record => {
      const parsed = receiptResult.safeParse(record.result);
      return { id: record.id, createdAt: record.createdAt, returned: record.returned,
        proofAvailable: parsed.success && parsed.data.ofId === ofId,
        operationId: parsed.success ? parsed.data.operationId : null,
        assemblyQuantity: parsed.success ? parsed.data.assemblyQuantity : null };
    }) };
  });
}

export async function returnAssemblyComponents(ofId: number, withdrawalId: string, body: AssemblyComponentReturn, audit: AuditContext,
  authorizeTransaction?: (tx: PoolClient) => Promise<void>) {
  return withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
    await tx.query('SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE', [ofId]);
    await authorizeTransaction?.(tx);
    const command = await beginStockCommand(tx, { audit, idempotency_key: body.idempotencyKey,
      command_type: 'MOVEMENT_COMPENSATE', request_payload: { ofId, withdrawalId, kind: 'ASSEMBLY_COMPONENT_RETURN', ...body } });
    if (command.existing) return command.existing.result_payload;
    const proposed = await readReturn(tx, ofId, withdrawalId);
    for (const lotId of [...new Set(proposed.movements.flatMap(item => item.lotId ? [item.lotId] : []))].sort()) {
      await assertOperationalLotQualityEligibility({ client: tx, lotId, qty: 0, purpose: 'RESERVE' });
    }
    // Quantity/quality commands also lock the OF. Read again after every lot is
    // held, so a preview can never authorize a stock or quality race.
    const current = await readReturn(tx, ofId, withdrawalId);
    if (current.version !== body.expectedVersion) throw new HttpError(409, 'ASSEMBLY_RETURN_CHANGED', 'La situation a changé. Relisez le retour proposé.');
    if (!current.canReturn) throw new HttpError(409, 'ASSEMBLY_RETURN_NOT_AVAILABLE', 'Ces composants ne peuvent pas être restitués par ce retour.', { blockers: current.blockers });
    const movements = [];
    for (const item of current.movements) {
      movements.push({ requirementId: item.requirementId, sourceOfId: item.sourceOfId,
        ...await returnAssemblyComponentTx(tx, { ofId, movementId: item.stockMovementId,
          reservationId: item.reservationId, quantity: item.quantity,
          key: `${body.idempotencyKey}:${item.reservationId}`, reason: body.reason }, audit) });
    }
    const result = { ofId, withdrawalId, assemblyQuantity: current.assemblyQuantity,
      sourceAllocations: current.sourceAllocations, movements };
    await completeStockCommand(tx, { audit, command, command_type: 'MOVEMENT_COMPENSATE',
      resource_type: 'ordres_fabrication', resource_id: String(ofId), result_payload: result });
    await preparationAudit(tx, audit, ofId, 'production.of.assembly-component-return', { ...result, reason: body.reason });
    return result;
  });
}
