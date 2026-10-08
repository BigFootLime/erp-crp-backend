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
  const value = decimal(original.movementValue), allocated = ratio(value * before,total);
  if (cursor.value === null || decimal(cursor.value) !== allocated) throw new Error('CUMP_RETURN_CURSOR_MISMATCH');
  const next = ratio(value * (before + moved),total);
  return { cost: { amount: text(next - allocated),reliability: original.reliability,sourceRef: original.entryRef },
    cursor: { originalMovementRef: original.movementRef,quantity: text(before + moved),value: text(next) } };
}
