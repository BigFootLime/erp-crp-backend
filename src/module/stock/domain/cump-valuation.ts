import { canonicalizeStockUnitCode } from '../../../shared/stock-unit';
import { CUMP_DECIMAL_SCALE as SCALE, parseCumpDecimal as decimal,
  formatCumpDecimal as text, roundCumpRatio as roundRatio } from './cump-decimal';

export const CUMP_FORMULA_VERSION = 'CERP-CUMP-1.0.0' as const;
export type CumpReliability = 'VERIFIED' | 'DECLARED' | 'UNKNOWN';
export type CumpScope = { articleId: string; owner: 'COMPANY' | `CLIENT:${string}`; unit: string; currency: string };
export type CumpState = { scope: CumpScope; quantity: string; value: string | null;
  reliability: CumpReliability; sourceRef: string | null };
export type CumpCostEvidence = { amount: string | null; reliability: CumpReliability; sourceRef: string | null };
export type CumpTransition = { scope: CumpScope; quantity: string; movementRef: string } & (
  | { kind: 'RECEIPT'; cost: CumpCostEvidence }
  | { kind: 'RETURN'; cost: CumpCostEvidence; originalMovementRef: string }
  | { kind: 'ISSUE' | 'SCRAP' }
  | { kind: 'TRANSFER'; destinationScope: CumpScope }
);
export type CumpTransitionResult = { formulaVersion: typeof CUMP_FORMULA_VERSION; before: CumpState; after: CumpState;
  quantityDelta: string; valueDelta: string | null; movementValue: string | null; unitCost: string | null;
  movementReliability: CumpReliability; issues: string[] };

// Journal values retain 12 decimals. Inputs are never rounded silently and are
// read as PostgreSQL numeric text; Number/float8 is not a financial transport.
function scope(value: CumpScope): CumpScope {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const unit = canonicalizeStockUnitCode(value.unit), currency = value.currency.trim().toUpperCase();
  if (!uuid.test(value.articleId) || !unit || !/^[A-Z]{3}$/.test(currency)) throw new Error('CUMP_SCOPE_INVALID');
  // clients.client_id / lots.client_proprietaire_id are business varchar keys,
  // not UUIDs. Preserve their exact case; the adapter resolves their ownership.
  const clientKey = value.owner.startsWith('CLIENT:') ? value.owner.slice(7) : null;
  if (value.owner !== 'COMPANY' && (!clientKey || clientKey !== clientKey.trim()
    || clientKey.length > 255 || /[\u0000-\u001f\u007f]/.test(clientKey))) throw new Error('CUMP_OWNER_INVALID');
  return { articleId: value.articleId.toLowerCase(), owner: value.owner,
    unit, currency };
}
function sameScope(left: CumpScope, right: CumpScope): boolean {
  return left.articleId === right.articleId && left.owner === right.owner && left.unit === right.unit && left.currency === right.currency;
}
function reliability(left: CumpReliability, right: CumpReliability): CumpReliability {
  return left === 'UNKNOWN' || right === 'UNKNOWN' ? 'UNKNOWN' : left === 'DECLARED' || right === 'DECLARED' ? 'DECLARED' : 'VERIFIED';
}
function cost(value: CumpCostEvidence): bigint | null {
  if (!['VERIFIED', 'DECLARED', 'UNKNOWN'].includes(value.reliability)) throw new Error('CUMP_RELIABILITY_INVALID');
  if (value.amount === null) {
    if (value.reliability !== 'UNKNOWN') throw new Error('CUMP_UNKNOWN_COST_RELIABILITY');
    return null;
  }
  if (value.reliability === 'UNKNOWN' || !value.sourceRef?.trim()) throw new Error('CUMP_COST_EVIDENCE_REQUIRED');
  return decimal(value.amount);
}

/** Pure journal calculation; source evidence and ownership must be verified by
 * the Stock repository under transaction locks, never supplied by an HTTP form.
 * No historical valuation is reconstructed and no physical stock is changed. */
export function applyCumpTransition(input: CumpState, transition: CumpTransition): CumpTransitionResult {
  const currentScope = scope(input.scope), movementScope = scope(transition.scope);
  if (!sameScope(currentScope, movementScope)) throw new Error('CUMP_SCOPE_MISMATCH');
  if (!transition.movementRef?.trim()) throw new Error('CUMP_MOVEMENT_EVIDENCE_REQUIRED');
  const quantity = decimal(input.quantity, true), moved = decimal(transition.quantity);
  if (moved <= 0n) throw new Error('CUMP_POSITIVE_QUANTITY_REQUIRED');
  if (!['VERIFIED', 'DECLARED', 'UNKNOWN'].includes(input.reliability)) throw new Error('CUMP_RELIABILITY_INVALID');
  const currentValue = quantity === 0n ? input.value === null ? null : decimal(input.value)
    : cost({ amount: input.value, reliability: input.reliability, sourceRef: input.sourceRef });
  if ((quantity < 0n && currentValue !== null) || (quantity === 0n && currentValue !== null && currentValue !== 0n)) throw new Error('CUMP_BALANCE_VALUE_INVALID');
  // Physical exhaustion establishes an empty balance, not a value for any
  // earlier unpriced issue. Its separate movement value remains unknown.
  const before: CumpState = { scope: currentScope, quantity: text(quantity), value: quantity === 0n ? '0' : currentValue === null ? null : text(currentValue),
    reliability: quantity === 0n ? 'VERIFIED' : input.reliability, sourceRef: input.sourceRef };
  const valueBefore = quantity === 0n ? 0n : currentValue;
  const issues: string[] = [];
  if (quantity !== 0n && valueBefore === null) issues.push('PREVIOUS_VALUE_UNKNOWN');
  let nextQuantity = quantity, nextValue = valueBefore, deltaQuantity = 0n, deltaValue: bigint | null = 0n;
  let movementValue: bigint | null = null, movementReliability: CumpReliability = 'UNKNOWN';
  let nextReliability = before.reliability;

  if (transition.kind === 'TRANSFER') {
    if (!sameScope(currentScope, scope(transition.destinationScope))) throw new Error('CUMP_TRANSFER_SCOPE_MISMATCH');
    // A location change is neither an acquisition nor a second consumption.
  } else if (transition.kind === 'RECEIPT' || transition.kind === 'RETURN') {
    if (transition.kind === 'RETURN' && (!transition.originalMovementRef?.trim() || transition.originalMovementRef === transition.movementRef)) throw new Error('CUMP_RETURN_SOURCE_REQUIRED');
    movementValue = cost(transition.cost); deltaValue = movementValue; deltaQuantity = moved;
    nextQuantity += moved; movementReliability = transition.cost.reliability;
    nextValue = valueBefore !== null && movementValue !== null ? valueBefore + movementValue : null;
    nextReliability = nextValue === null ? 'UNKNOWN' : reliability(before.reliability, transition.cost.reliability);
    if (movementValue === null) issues.push('ENTRY_VALUE_UNKNOWN');
  } else if (transition.kind === 'ISSUE' || transition.kind === 'SCRAP') {
    deltaQuantity = -moved; nextQuantity -= moved;
    if (quantity > 0n && moved <= quantity && valueBefore !== null) {
      // The last issue takes the exact residual value; intermediate issues
      // prorate the total, avoiding drift from a rounded displayed unit cost.
      movementValue = moved === quantity ? valueBefore : roundRatio(valueBefore * moved, quantity);
      deltaValue = -movementValue; nextValue = valueBefore - movementValue;
      movementReliability = before.reliability;
    } else { nextValue = null; deltaValue = null; nextReliability = 'UNKNOWN'; }
  } else throw new Error('CUMP_TRANSITION_INVALID');

  if (nextQuantity < 0n) { nextValue = null; nextReliability = 'UNKNOWN'; issues.push('NEGATIVE_STOCK'); }
  if (nextQuantity === 0n) { nextValue = 0n; nextReliability = 'VERIFIED'; }
  const after: CumpState = { scope: currentScope, quantity: text(nextQuantity), value: nextValue === null ? null : text(nextValue),
    reliability: nextReliability, sourceRef: transition.kind === 'TRANSFER' ? before.sourceRef : transition.movementRef };
  return { formulaVersion: CUMP_FORMULA_VERSION, before, after, quantityDelta: text(deltaQuantity),
    valueDelta: deltaValue === null ? null : text(deltaValue), movementValue: movementValue === null ? null : text(movementValue),
    unitCost: movementValue === null ? null : text(roundRatio(movementValue * SCALE, moved)), movementReliability, issues };
}
