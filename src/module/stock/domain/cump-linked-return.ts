import { parseCumpDecimal as decimal, formatCumpDecimal as text, roundCumpRatio as ratio } from './cump-decimal';
import { normalizeCumpScope, type CumpScope, type CumpCostEvidence, type CumpReliability } from './cump-valuation';

export type CumpOriginalValue = { movementRef: string; entryRef: string; scope: CumpScope;
  quantity: string; movementValue: string | null; reliability: CumpReliability };
export type CumpReturnCursor = { originalMovementRef: string; quantity: string; value: string | null };

/** The repository supplies the exact original immutable entry and a locked
 * return cursor. No latest unit cost, catalogue value or free HTTP price. */
export function allocateCumpLinkedReturn(original: CumpOriginalValue, scope: CumpScope, returned: string,
  cursor: CumpReturnCursor): { cost: CumpCostEvidence; cursor: CumpReturnCursor } {
  if (!original.movementRef.trim() || !original.entryRef.trim() || original.movementRef !== cursor.originalMovementRef
    || JSON.stringify(normalizeCumpScope(original.scope)) !== JSON.stringify(normalizeCumpScope(scope))) throw new Error('CUMP_RETURN_SCOPE_MISMATCH');
  const total = decimal(original.quantity), before = decimal(cursor.quantity), moved = decimal(returned);
  if (total <= 0n || moved <= 0n || before + moved > total) throw new Error('CUMP_RETURN_QUANTITY_EXCEEDED');
  if (original.movementValue === null) {
    if (original.reliability !== 'UNKNOWN' || cursor.value !== null) throw new Error('CUMP_RETURN_EVIDENCE_INVALID');
    return { cost: { amount: null,reliability: 'UNKNOWN',sourceRef: original.entryRef },
      cursor: { originalMovementRef: original.movementRef,quantity: text(before + moved),value: null } };
  }
  if (original.reliability !== 'DECLARED' && original.reliability !== 'VERIFIED') throw new Error('CUMP_RETURN_EVIDENCE_INVALID');
  const value = decimal(original.movementValue), allocated = cursor.value===null ? null : decimal(cursor.value);
  // The repository verifies the immutable allocation ledger. After an older
  // return is cancelled out of order, net value need not equal the cumulative
  // ratio (one rounding unit may remain). Allocate the exact remaining value.
  if (allocated===null || allocated>value || (before===0n && allocated!==0n)
    || (before===total && allocated!==value)) throw new Error('CUMP_RETURN_CURSOR_MISMATCH');
  const remainder = value - allocated, remaining = total - before;
  const amount = moved===remaining ? remainder : ratio(remainder * moved,remaining);
  return { cost: { amount: text(amount),reliability: original.reliability,sourceRef: original.entryRef },
    cursor: { originalMovementRef: original.movementRef,quantity: text(before + moved),value: text(allocated + amount) } };
}
