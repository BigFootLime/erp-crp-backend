import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseCumpDecimal as decimal, formatCumpDecimal as text } from '../domain/cump-decimal';
import { allocateCumpLinkedReturn, type CumpOriginalValue, type CumpReturnCursor } from '../domain/cump-linked-return';
import { applyCumpReturnAllocationDelta } from '../domain/cump-return-allocation';
import type { CumpJournalSource } from '../domain/cump-posting-source';
import type { CumpCostEvidence, CumpReliability, CumpScope } from '../domain/cump-valuation';
import * as sql from './cump-return-ledger.sql';

type Tx = Pick<PoolClient,'query'>;
type Entry = { id: string; article_id: string; source_sequence: string; kind: string; quantity_delta: string | null;
  movement_value: string | null; reliability: CumpReliability; source_snapshot: unknown; source_valid: boolean };
type CursorRow = { original_entry_id: string; quantity: string; value: string | null; latest_event_id: string; source_valid: boolean };
type Event = { id: string; original_movement_id: string; original_entry_id: string; owner_key: string; stock_unit: string;
  currency: string; quantity_delta: string; value_delta: string | null; source_valid: boolean };
type Plan = { id: string; original: CumpOriginalValue; originalEntryId: string; previousEventId: string | null;
  inverseOf: string | null; before: CumpReturnCursor; after: CumpReturnCursor; deltaQuantity: string; deltaValue: string | null };
const absolute = (value: bigint) => value<0n ? -value : value;
const parameters = (movementId: string,scope: CumpScope) => [movementId,scope.owner,scope.unit,scope.currency];

async function readOriginal(tx: Tx,row: CumpJournalSource,movementId: string,scope: CumpScope): Promise<{ entry: Entry; value: CumpOriginalValue }> {
  const entries = (await tx.query<Entry>(sql.CUMP_RETURN_ORIGINAL_SQL,parameters(movementId,scope))).rows;
  const e = entries[0];
  if (entries.length!==1 || !e.source_valid || e.article_id!==scope.articleId || e.quantity_delta===null
    || BigInt(e.source_sequence)>=BigInt(row.sequence) || decimal(e.quantity_delta,true)===0n) throw new Error('CUMP_RETURN_ORIGINAL_ENTRY_MISSING');
  return { entry: e,value: { movementRef: movementId,entryRef: `stock-valuation-entry:${e.id}`,scope,
    quantity: text(absolute(decimal(e.quantity_delta,true))),
    movementValue: e.movement_value===null ? null : text(decimal(e.movement_value)),reliability: e.reliability } };
}
async function readCursor(tx: Tx,original: CumpOriginalValue,entryId: string,required = false): Promise<{ value: CumpReturnCursor; latestEventId: string | null }> {
  const c = (await tx.query<CursorRow>(sql.CUMP_RETURN_NET_CURSOR_SQL,parameters(original.movementRef,original.scope))).rows[0];
  if (required && !c) throw new Error('CUMP_RETURN_CURSOR_PROOF_MISSING');
  if (c && (!c.source_valid || c.original_entry_id!==entryId || !c.latest_event_id)) throw new Error('CUMP_RETURN_CURSOR_PROOF_INVALID');
  return { value: { originalMovementRef: original.movementRef,quantity: c ? text(decimal(c.quantity)) : '0',
    value: c ? c.value===null ? null : text(decimal(c.value)) : original.movementValue===null ? null : '0' },latestEventId: c?.latest_event_id ?? null };
}
function physicalDirection(row: CumpJournalSource): 'RETURN' | 'RECEIPT_REVERSAL' {
  const s = row.source_snapshot as Record<string,unknown>;
  return s.movement_type==='OUT' || s.movement_type==='SCRAP' || s.movement_type==='DEPRECIATE'
    ||((s.movement_type==='ADJUST' || s.movement_type==='ADJUSTMENT') && typeof s.quantity==='string' && decimal(s.quantity,true)<0n)
    ? 'RECEIPT_REVERSAL' : 'RETURN';
}

/** Plan every primary allocation and inverse before writing any cursor.
 * Inverting all original events also handles returns of returns; the immutable
 * entry, quantity cap and exact amount bound each step without physical locks. */
export async function resolveCumpLinkedReturnTx(tx: Tx,row: CumpJournalSource,originalMovementId: string,scope: CumpScope,
  quantity: string,appliedEntryId: string): Promise<{ kind: 'RETURN' | 'RECEIPT_REVERSAL'; cost: CumpCostEvidence;
    proof: Record<string,unknown>; issues: string[] }> {
  const kind = physicalDirection(row);
  const unresolved = (code: string) => ({ kind,cost: { amount: null,reliability: 'UNKNOWN' as const,sourceRef: `stock-movement:${originalMovementId}` },
    proof: { original_movement_id: originalMovementId,original_entry_id: null,return_allocation_event_ids: [] },issues: [code] });
  let plans: Plan[],cost: CumpCostEvidence,originalEntry: Entry;
  try {
    const original = await readOriginal(tx,row,originalMovementId,scope); originalEntry = original.entry;
    if ((decimal(originalEntry.quantity_delta!,true)>0n ? 'RECEIPT_REVERSAL' : 'RETURN')!==kind) throw new Error('CUMP_RETURN_DIRECTION_MISMATCH');
    const cursor = await readCursor(tx,original.value,originalEntry.id);
    const allocated = allocateCumpLinkedReturn(original.value,scope,quantity,cursor.value); cost = allocated.cost;
    const after = applyCumpReturnAllocationDelta(original.value,cursor.value,quantity,cost.amount);
    plans = [{ id: randomUUID(),original: original.value,originalEntryId: originalEntry.id,previousEventId: cursor.latestEventId,
      inverseOf: null,before: cursor.value,after,deltaQuantity: quantity,deltaValue: cost.amount }];
    const events = (await tx.query<Event>(sql.CUMP_RETURN_ORIGINAL_EVENTS_SQL,[originalEntry.id])).rows;
    if (events.length>64 || ((originalEntry.kind==='RETURN' || originalEntry.kind==='RECEIPT_REVERSAL') && !events.length))
      throw new Error('CUMP_RETURN_ORIGINAL_LEDGER_INCOMPLETE');
    const targets = new Set([originalMovementId]),moved = decimal(quantity);
    for (const event of events) {
      if (!event.source_valid || event.owner_key!==scope.owner || event.stock_unit!==scope.unit || event.currency!==scope.currency
        || targets.has(event.original_movement_id) || absolute(decimal(event.quantity_delta,true))!==decimal(original.value.quantity)
        || (event.value_delta===null ? null : text(absolute(decimal(event.value_delta,true))))!==original.value.movementValue)
        throw new Error('CUMP_RETURN_ORIGINAL_LEDGER_INVALID');
      targets.add(event.original_movement_id);
      const target = await readOriginal(tx,row,event.original_movement_id,scope);
      if (target.entry.id!==event.original_entry_id) throw new Error('CUMP_RETURN_ORIGINAL_LEDGER_INVALID');
      const prior = await readCursor(tx,target.value,target.entry.id,true),sign = decimal(event.quantity_delta,true)>0n ? -1n : 1n;
      const deltaQuantity = text(sign*moved),deltaValue = cost.amount===null ? null : text(sign*decimal(cost.amount));
      const next = applyCumpReturnAllocationDelta(target.value,prior.value,deltaQuantity,deltaValue);
      plans.push({ id: randomUUID(),original: target.value,originalEntryId: target.entry.id,previousEventId: prior.latestEventId,
        inverseOf: event.id,before: prior.value,after: next,deltaQuantity,deltaValue });
    }
  } catch (error) {
    if (!(error instanceof Error) || !/^CUMP_(RETURN_|DECIMAL_|RATIO_)/.test(error.message)) throw error;
    return unresolved(error.message);
  }
  for (const plan of plans) {
    const snapshot = { schema_version: 1,stock_source_sha256: row.source_sha256,before_cursor: plan.before,after_cursor: plan.after };
    const inserted = await tx.query(sql.CUMP_RETURN_INSERT_EVENT_SQL,[plan.id,plan.original.movementRef,plan.originalEntryId,
      appliedEntryId,row.movement_id,scope.owner,scope.unit,scope.currency,plan.previousEventId,plan.inverseOf,
      plan.deltaQuantity,plan.deltaValue,JSON.stringify(snapshot)]);
    if (inserted.rows.length!==1) throw new Error('CUMP_RETURN_EVENT_NOT_STORED');
    const updated = await tx.query(sql.CUMP_RETURN_STORE_NET_CURSOR_SQL,[plan.original.movementRef,scope.owner,scope.unit,scope.currency,
      plan.originalEntryId,plan.after.quantity,plan.after.value,plan.id]);
    if (updated.rows.length!==1) throw new Error('CUMP_RETURN_CURSOR_NOT_STORED');
  }
  return { kind,cost,proof: { original_movement_id: originalMovementId,original_entry_id: originalEntry.id,
    return_allocation_event_ids: plans.map(plan=>plan.id) },issues: [] };
}
