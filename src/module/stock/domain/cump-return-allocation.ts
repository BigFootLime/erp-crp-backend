import { parseCumpDecimal as decimal, formatCumpDecimal as text } from './cump-decimal';
import type { CumpOriginalValue, CumpReturnCursor } from './cump-linked-return';

/** The Stock repository verifies this net cursor against immutable events.
 * Releasing an allocation never changes the original receipt/issue value. */
export function applyCumpReturnAllocationDelta(original: CumpOriginalValue,cursor: CumpReturnCursor,
  deltaQuantity: string,deltaValue: string | null): CumpReturnCursor {
  if (original.movementRef!==cursor.originalMovementRef) throw new Error('CUMP_RETURN_SCOPE_MISMATCH');
  const total = decimal(original.quantity), before = decimal(cursor.quantity),delta = decimal(deltaQuantity,true);
  const after = before + delta;
  if (delta===0n || total<=0n || before>total || after<0n || after>total) throw new Error('CUMP_RETURN_QUANTITY_EXCEEDED');
  decimal(text(after));
  if (original.movementValue===null) {
    if (original.reliability!=='UNKNOWN' || cursor.value!==null || deltaValue!==null) throw new Error('CUMP_RETURN_EVIDENCE_INVALID');
    return { originalMovementRef: original.movementRef,quantity: text(after),value: null };
  }
  if ((original.reliability!=='VERIFIED' && original.reliability!=='DECLARED') || cursor.value===null || deltaValue===null)
    throw new Error('CUMP_RETURN_EVIDENCE_INVALID');
  const totalValue = decimal(original.movementValue), beforeValue = decimal(cursor.value), changed = decimal(deltaValue,true);
  const afterValue = beforeValue + changed;
  if ((delta>0n && changed<0n) || (delta<0n && changed>0n) || beforeValue>totalValue || afterValue<0n || afterValue>totalValue
    || (before===0n && beforeValue!==0n) || (after===0n && afterValue!==0n) || (after===total && afterValue!==totalValue))
    throw new Error('CUMP_RETURN_CURSOR_MISMATCH');
  decimal(text(afterValue));
  return { originalMovementRef: original.movementRef,quantity: text(after),value: text(afterValue) };
}
