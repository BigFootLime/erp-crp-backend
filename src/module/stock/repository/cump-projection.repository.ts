import { randomUUID } from 'node:crypto';
import { canonicalizeStockUnitCode } from '../../../shared/stock-unit';
import type { PoolClient } from 'pg';
import { CUMP_FORMULA_VERSION, type CumpCostEvidence, type CumpReliability, type CumpScope,
  type CumpState, type CumpTransition, type CumpTransitionResult } from '../domain/cump-valuation';
import { parseCumpDecimal as decimal, formatCumpDecimal as text } from '../domain/cump-decimal';
import { type CumpOpeningRow, type CumpOpening } from '../domain/cump-opening';
import type { CumpJournalSource } from '../domain/cump-posting-source';
import { readReceiptAcquisitionFacts } from '../domain/receipt-acquisition-snapshot';
import { resolveReceiptAcquisitionValue } from '../domain/receipt-acquisition-value';
import { allocateCumpLinkedReturn } from '../domain/cump-linked-return';
import * as sql from './cump-projection.sql';

type Tx = Pick<PoolClient,'query'>;
export type CumpBalance = { state: CumpState; latestEntryId: string; latestSequence: string };
type Balance = CumpBalance;
type Proof = Record<string,unknown>;
const unknown = (sourceRef: string | null = null): CumpCostEvidence => ({ amount: null,reliability: 'UNKNOWN',sourceRef });
const scopeParameters = (scope: CumpScope) => [scope.articleId,scope.owner,scope.unit,scope.currency];

export async function readCumpOpeningsTx(tx: Tx) {
  const rows = (await tx.query<CumpOpeningRow>(sql.CUMP_OPENING_SOURCES_SQL)).rows;
  if (rows.length>10000) throw new Error('CUMP_OPENING_WINDOW_TOO_DENSE');
  return rows;
}
export async function readCumpSourceWindowTx(tx: Tx, sequence: string, limit: number) {
  if (!/^\d+$/.test(sequence) || !Number.isInteger(limit) || limit<1 || limit>250) throw new Error('CUMP_WINDOW_INVALID');
  return (await tx.query<CumpJournalSource>(sql.CUMP_SOURCE_WINDOW_SQL,[sequence,limit])).rows;
}
export async function readCumpTransferGroupTx(tx: Tx, parentId: string) {
  return (await tx.query<CumpJournalSource>(sql.CUMP_TRANSFER_GROUP_SQL,[parentId])).rows;
}
export async function cumpArticleBlockedTx(tx: Tx, articleId: string) {
  return (await tx.query(sql.CUMP_BLOCKED_ARTICLE_SQL,[articleId])).rows.length>0;
}
export async function readCumpBalanceTx(tx: Tx, scope: CumpScope): Promise<Balance | null> {
  const row = (await tx.query<{ quantity: string; value: string | null; reliability: CumpReliability;
    source_ref: string | null; latest_entry_id: string; latest_sequence: string }>(sql.CUMP_SCOPE_BALANCE_SQL,scopeParameters(scope))).rows[0];
  return row ? { state: { scope,quantity: row.quantity,value: row.value,reliability: row.reliability,sourceRef: row.source_ref },
    latestEntryId: row.latest_entry_id,latestSequence: row.latest_sequence } : null;
}
async function insertEntry(tx: Tx, values: unknown[]) {
  if ((await tx.query(sql.CUMP_INSERT_ENTRY_SQL,values)).rows.length!==1) throw new Error('CUMP_ENTRY_NOT_STORED');
}
async function storeBalance(tx: Tx, balance: Balance) {
  const s = balance.state;
  await tx.query(sql.CUMP_STORE_BALANCE_SQL,[...scopeParameters(s.scope),s.quantity,s.value,s.reliability,s.sourceRef,
    balance.latestSequence,balance.latestEntryId]);
}
export async function writeCumpOpeningTx(tx: Tx, opening: CumpOpening, proof: Proof = {}): Promise<Balance> {
  if (opening.state.quantity!=='0' && (opening.state.value!==null || opening.state.reliability!=='UNKNOWN')) throw new Error('CUMP_OPENING_PRICE_FORBIDDEN');
  const id = randomUUID(), state = { ...opening.state,sourceRef: `stock-valuation-entry:${id}` };
  const snapshot = { ...proof,schema_version: 1,opening_ids: opening.openingIds,after_state: state };
  await insertEntry(tx,[id,null,state.scope.articleId,state.scope.owner,state.scope.unit,state.scope.currency,null,
    'OPENING',CUMP_FORMULA_VERSION,state.quantity,null,null,state.reliability,JSON.stringify(snapshot),JSON.stringify(proof.issues ?? [])]);
  const balance = { state,latestEntryId: id,latestSequence: '0' }; await storeBalance(tx,balance); return balance;
}
export async function writeCumpUnresolvedTx(tx: Tx, row: CumpJournalSource | null, articleId: string,
  currency: string, issues: string[], proof: Proof = {}) {
  const snapshot = { ...proof,schema_version: 1,blocking: true,stock_source_sha256: row?.source_sha256 ?? null };
  await insertEntry(tx,[randomUUID(),row?.movement_id ?? null,articleId,null,null,currency,row?.sequence ?? null,
    'UNRESOLVED',CUMP_FORMULA_VERSION,null,null,null,'UNKNOWN',JSON.stringify(snapshot),JSON.stringify(issues)]);
}
export async function writeCumpZeroTx(tx: Tx, row: CumpJournalSource, currency: string) {
  await insertEntry(tx,[randomUUID(),row.movement_id,row.article_id,null,null,currency,row.sequence,'ZERO',CUMP_FORMULA_VERSION,
    '0','0',null,'UNKNOWN',JSON.stringify({ schema_version: 1,stock_source_sha256: row.source_sha256 }),JSON.stringify([])]);
}
export async function writeCumpResultTx(tx: Tx, row: CumpJournalSource, balance: Balance, kind: CumpTransition['kind'],
  id: string, result: CumpTransitionResult, proof: Proof, issues: string[]) {
  const scope = result.after.scope;
  const snapshot = { ...proof,schema_version: 1,stock_source_sha256: row.source_sha256,
    acquisition_source_sha256: row.acquisition_sha256,previous_entry_id: balance.latestEntryId,
    before_state: result.before,after_state: result.after,result };
  await insertEntry(tx,[id,row.movement_id,scope.articleId,scope.owner,scope.unit,scope.currency,row.sequence,kind,
    result.formulaVersion,result.quantityDelta,result.valueDelta,result.movementValue,result.movementReliability,
    JSON.stringify(snapshot),JSON.stringify([...new Set([...issues,...result.issues])])]);
  await storeBalance(tx,{ state: result.after,latestEntryId: id,latestSequence: row.sequence });
}

/** A quantity cursor is advanced once per complete receipt source, even when
 * its price is missing. A history gap or changed fee base poisons allocation. */
export async function resolveCumpAcquisitionTx(tx: Tx, row: CumpJournalSource, currency: string): Promise<{
  cost: CumpCostEvidence; proof: Proof; issues: string[];
}> {
  const parsed = readReceiptAcquisitionFacts(row.acquisition_valid ? row.acquisition_snapshot : null);
  const facts = parsed.facts, order = facts?.order;
  if (!facts || !order) return { cost: unknown(),proof: { acquisition_fee_counted: false },
    issues: parsed.issues.length ? parsed.issues : ['PURCHASE_ORDER_SOURCE_MISSING'] };
  const cursor = (await tx.query<{ quantity: string; basis_snapshot: Record<string,unknown>; poisoned: boolean; source_valid: boolean }>(
    sql.CUMP_FEE_CURSOR_SQL,[order.lineId])).rows[0];
  let basisValid = true;
  const numericBasis = (value: string | null) => {
    try { return value === null ? null : text(decimal(value)); }
    catch { basisValid = false; return value; }
  };
  const basis = { quantity: numericBasis(order.quantity),additionalFees: numericBasis(order.additionalFees),
    unit: canonicalizeStockUnitCode(order.unit),currency: order.currency?.trim().toUpperCase() ?? null };
  if (basis.quantity===null || basis.unit===null || !basis.currency || !/^[A-Z]{3}$/.test(basis.currency)) basisValid = false;
  const previous = cursor?.quantity ?? '0';
  let received: bigint, before: bigint;
  try { received = decimal(facts.receiptQuantity); before = decimal(previous); decimal(text(before + received)); }
  catch { return { cost: unknown(),proof: { acquisition_fee_counted: false },issues: ['ACQUISITION_FEE_QUANTITY_MISSING'] }; }
  const changed = Boolean(cursor && Object.entries(basis).some(([key,value]) => cursor.basis_snapshot[key]!==value));
  const historyGap = (await tx.query<{missing: boolean}>(sql.CUMP_FEE_HISTORY_GAP_SQL,[order.lineId,order.id,row.sequence])).rows[0]?.missing !== false;
  const poisoned = Boolean(!basisValid || cursor?.poisoned || (cursor && !cursor.source_valid) || changed || historyGap);
  await tx.query(sql.CUMP_STORE_FEE_CURSOR_SQL,[order.lineId,text(before + received),JSON.stringify(basis),poisoned]);
  const allocation = { orderLineId: order.lineId,beforeQuantity: previous,sourceRef: `stock-acquisition-cursor:${order.lineId}:${previous}` };
  const proof = { acquisition_fee_counted: true,fee_allocation_before: allocation,fee_basis: cursor?.basis_snapshot ?? basis,fee_basis_poisoned: poisoned };
  // Changes in a zero-fee line do not require an allocation. Once a forfait
  // appears (or a prior forfait changes), its entire basis must be reconciled.
  let hasFee = false;
  try { hasFee = order.additionalFees!==null && decimal(order.additionalFees)>0n; } catch { hasFee = true; }
  const priorFee = cursor?.basis_snapshot.additionalFees;
  let hadFee = false;
  try { hadFee = typeof priorFee==='string' && decimal(priorFee)>0n; } catch { hadFee = true; }
  if (poisoned && (hasFee || hadFee)) return { cost: unknown(facts.sourceRef),proof,
    issues: [changed ? 'ACQUISITION_FEE_BASE_CHANGED' : historyGap ? 'ACQUISITION_FEE_HISTORY_INCOMPLETE' : 'ACQUISITION_FEE_CURSOR_UNRESOLVED'] };
  const value = resolveReceiptAcquisitionValue(facts,currency,poisoned ? undefined : allocation);
  return { cost: value,proof,issues: value.issues };
}

export async function resolveCumpLinkedReturnTx(tx: Tx, row: CumpJournalSource, originalMovementId: string, scope: CumpScope,
  quantity: string): Promise<{ kind: 'RETURN' | 'RECEIPT_REVERSAL'; cost: CumpCostEvidence; proof: Proof; issues: string[] }> {
  const original = (await tx.query<{ id: string; article_id: string; source_sequence: string; kind: string;
    quantity_delta: string | null; movement_value: string | null; reliability: CumpReliability; source_snapshot: unknown }>(
    sql.CUMP_ORIGINAL_ENTRY_SQL,[originalMovementId,scope.owner,scope.unit,scope.currency])).rows;
  const physical = readPhysicalReturnDirection(row);
  const resultUnknown = (code: string) => ({ kind: physical,cost: unknown(`stock-movement:${originalMovementId}`),
    proof: { original_movement_id: originalMovementId,original_entry_id: null },issues: [code] });
  if (original.length!==1 || original[0].article_id!==scope.articleId || BigInt(original[0].source_sequence)>=BigInt(row.sequence)
    || original[0].quantity_delta===null) return resultUnknown('ORIGINAL_VALUATION_ENTRY_MISSING');
  const entry = original[0], signed = decimal(entry.quantity_delta!,true);
  if (signed===0n) return resultUnknown('ORIGINAL_TRANSFER_REVERSAL_UNRESOLVED');
  const kind = signed>0n ? 'RECEIPT_REVERSAL' as const : 'RETURN' as const;
  if (kind!==physical) return resultUnknown('ORIGINAL_RETURN_DIRECTION_MISMATCH');
  const current = (await tx.query<{ original_entry_id: string; quantity: string; value: string | null }>(sql.CUMP_RETURN_CURSOR_SQL,
    [originalMovementId,scope.owner,scope.unit,scope.currency])).rows[0];
  if (current && current.original_entry_id!==entry.id) return { ...resultUnknown('ORIGINAL_VALUATION_ENTRY_CHANGED'),kind };
  let allocated: ReturnType<typeof allocateCumpLinkedReturn>;
  try {
    allocated = allocateCumpLinkedReturn({ movementRef: originalMovementId,entryRef: `stock-valuation-entry:${entry.id}`,
      scope,quantity: text(signed<0n ? -signed : signed),movementValue: entry.movement_value,reliability: entry.reliability },scope,quantity,
      { originalMovementRef: originalMovementId,quantity: current?.quantity ?? '0',value: current ? current.value : entry.movement_value===null ? null : '0' });
  } catch (error) {
    if (!(error instanceof Error) || !/^CUMP_(RETURN_|DECIMAL_)/.test(error.message)) throw error;
    return resultUnknown(error.message);
  }
  const updated = await tx.query(sql.CUMP_STORE_RETURN_CURSOR_SQL,[originalMovementId,scope.owner,scope.unit,scope.currency,
    entry.id,allocated.cursor.quantity,allocated.cursor.value]);
  if (updated.rows.length!==1) throw new Error('CUMP_RETURN_CURSOR_NOT_STORED');
  return { kind,cost: allocated.cost,proof: { original_movement_id: originalMovementId,original_entry_id: entry.id,
    return_cursor_before: current ?? { quantity: '0',value: entry.movement_value===null ? null : '0' },return_cursor_after: allocated.cursor },issues: [] };
}

function readPhysicalReturnDirection(row: CumpJournalSource): 'RETURN' | 'RECEIPT_REVERSAL' {
  const snapshot = row.source_snapshot as Record<string,unknown>;
  if (snapshot.movement_type==='OUT' || snapshot.movement_type==='SCRAP' || snapshot.movement_type==='DEPRECIATE'
    || ((snapshot.movement_type==='ADJUST' || snapshot.movement_type==='ADJUSTMENT')
      && typeof snapshot.quantity==='string' && decimal(snapshot.quantity,true)<0n)) return 'RECEIPT_REVERSAL';
  return 'RETURN';
}
