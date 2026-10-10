import { describe, expect, it } from 'vitest';
import { planDeliveryStockRecovery, type RecoveryStockCandidate } from './delivery-stock-recovery';
const candidate = (patch: Partial<RecoveryStockCandidate> = {}): RecoveryStockCandidate => ({
  stock_batch_id: 'batch1', stock_level_id: 'level1', lot_id: 'lot1', batch_available: '10', level_available: '10', quality_available: '10', blocker: null, ...patch,
});
describe('delivery stock recovery', () => {
  it('reserves only the actual uncovered remainder', () => {
    expect(planDeliveryStockRecovery('3',[candidate()])).toEqual({ rows: [{ stock_batch_id: 'batch1', quantity: '3' }], reserved_quantity:'3', missing_quantity:'0' });
  });
  it('uses FIFO and reports shortage without inventing stock or an OF', () => {
    const result=planDeliveryStockRecovery('8',[candidate({ batch_available:'2' }),candidate({stock_batch_id:'batch2',stock_level_id:'level2',lot_id:'lot2',batch_available:'3'})]);
    expect(result.rows.map(r=>r.quantity)).toEqual(['2','3']); expect(result.missing_quantity).toBe('3');
  });
  it('does not charge a shared stock level twice', () => {
    const result=planDeliveryStockRecovery('10',[candidate({batch_available:'6',level_available:'7'}),candidate({stock_batch_id:'batch2',lot_id:'lot2',batch_available:'6',level_available:'7'})]);
    expect(result.reserved_quantity).toBe('7'); expect(result.missing_quantity).toBe('3');
  });
  it('does not charge a lot quality entitlement twice across locations', () => {
    const result=planDeliveryStockRecovery('10',[candidate({batch_available:'4',quality_available:'5'}),candidate({stock_batch_id:'batch2',stock_level_id:'level2',batch_available:'4',quality_available:'5'})]);
    expect(result.reserved_quantity).toBe('5');
  });
  it('excludes blocked lots and preserves decimal precision', () => {
    expect(planDeliveryStockRecovery('0.300000',[candidate({blocker:'Quality pending'}),candidate({stock_batch_id:'batch2',batch_available:'0.100000'}),candidate({stock_batch_id:'batch3',batch_available:'0.200000'})]).missing_quantity).toBe('0');
  });
  it('rejects duplicate positions and inconsistent negative coverage', () => {
    expect(()=>planDeliveryStockRecovery('3',[candidate(),candidate()])).toThrow();
    expect(()=>planDeliveryStockRecovery('-1',[])).toThrow();
  });
  it('does not reserve again when already fully covered', () => {
    expect(planDeliveryStockRecovery('0',[candidate()]).rows).toEqual([]);
  });
});
