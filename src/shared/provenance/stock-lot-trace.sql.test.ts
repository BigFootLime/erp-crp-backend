import { describe, expect, it } from 'vitest';
import { stockLotTraceReferenceValuesSql } from './stock-lot-trace.sql';

describe('static trace SQL boundary', () => {
  it.each(['r.lot_id','allocation.lot_id','l.id'])('accepts the existing static lot expression %s', expression => {
    expect(() => stockLotTraceReferenceValuesSql(expression,'MP_LOT')).not.toThrow();
  });
  it.each(["r.lot_id; DELETE FROM lots", "'user-value'", 'lot_id', '$1', 'r.lot_id OR true', 'r.lot_id--'])('refuses input that can escape the static expression: %s', expression => {
    expect(() => stockLotTraceReferenceValuesSql(expression,'MP_LOT')).toThrow('Invalid static lot trace expression');
  });
  it('does not let an unchecked kind become SQL', () => {
    expect(() => stockLotTraceReferenceValuesSql('r.lot_id', 'UNKNOWN' as never)).toThrow('Invalid static lot trace expression');
  });
});
