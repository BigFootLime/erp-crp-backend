import { describe, expect, it } from 'vitest';
import { planDeliveryUrgency, type UrgencyDonor } from './delivery-urgency';
const donor = (patch: Partial<UrgencyDonor> = {}): UrgencyDonor => ({
  reservation_id: 'r1', allocation_id: 2, client_id: '195', article_id: 'article1',
  lane: 'DELIVERY', version_compatible: true, protected_due_date: '2026-10-30',
  reservation_remaining: '10', prepared_quantity: '0', stock_batch_id: 'b1', stock_level_id: 'l1',
  batch_total: '10', batch_reserved: '10', batch_depreciated: '0',
  level_total: '10', level_reserved: '10', level_depreciated: '0', blocker: null, ...patch,
});
const plan = (donors: UrgencyDonor[], requested='8', free='0') => planDeliveryUrgency({
  allocation_id: 1, client_id: '195', article_id: 'article1', requested_quantity: requested,
  uncovered_quantity: '10', free_quantity: free, today: '2026-10-12', donors,
});
describe('urgency donor preview #1033', () => {
  it('does not offer the same reserved quantity to simultaneous pending urgencies', () => {
    expect(plan([donor({pending_quantity:'7'})]).recovery_quantity).toBe('3');
    expect(plan([donor({pending_quantity:'10'})]).rows[0].blocker).toMatch(/déjà proposée/);
    expect(plan([donor({pending_quantity:'12'})]).recovery_quantity).toBe('0');
  });
  it('uses free stock first and never authorizes a withdrawal from the preview', () => {
    expect(plan([donor()], '8', '8')).toMatchObject({ free_quantity:'8', recovery_quantity:'0', shortage_quantity:'0', requires_planner_validation:false, can_withdraw:false });
    expect(plan([donor()], '8', '3')).toMatchObject({ free_quantity:'3', recovery_quantity:'5', shortage_quantity:'0', requires_planner_validation:true, can_withdraw:false });
  });
  it.each([
    {client_id:'other'}, {allocation_id:1}, {article_id:'other'}, {lane:'ASSEMBLY'}, {lane:'FREE'},
    {version_compatible:false}, {protected_due_date:null}, {protected_due_date:'2026-10-11'}, {blocker:'Non-conformité ouverte'},
  ])('excludes a donor that cannot protect the original affair: %j', patch => {
    const result=plan([donor(patch)]); expect(result.recovery_quantity).toBe('0'); expect(result.rows[0].blocker).toBeTruthy();
  });
  it('keeps prepared and consumed quantities outside the loan', () => {
    const result=plan([donor({reservation_remaining:'6',prepared_quantity:'4'})]);
    expect(result.recovery_quantity).toBe('2'); expect(result.shortage_quantity).toBe('6');
  });
  it('preserves prepared quantities when actual physical stock is below reserved stock', () => {
    expect(plan([donor({batch_total:'5',level_total:'5',prepared_quantity:'8'})]).recovery_quantity).toBe('0');
  });
  it('preserves reservations outside the candidate set at both batch and level scope', () => {
    expect(plan([donor({reservation_remaining:'6',batch_reserved:'12',level_reserved:'12'})]).recovery_quantity).toBe('4');
  });
  it('shares physical capacity without double counting two donor reservations on one batch', () => {
    const shared={reservation_remaining:'5',batch_total:'7',level_total:'7'};
    const result=plan([donor(shared),donor({...shared,reservation_id:'r2',allocation_id:3})]);
    expect(result.recovery_quantity).toBe('7'); expect(result.shortage_quantity).toBe('1');
  });
  it('shares a stock level across two batches and respects depreciation', () => {
    const shared={reservation_remaining:'5',batch_total:'5',batch_reserved:'5',level_total:'8',level_depreciated:'1'};
    expect(plan([donor(shared),donor({...shared,reservation_id:'r2',stock_batch_id:'b2'})]).recovery_quantity).toBe('7');
  });
  it('takes from the latest protected deadline first, retaining the date to recover before', () => {
    const result=plan([donor({reservation_id:'near',protected_due_date:'2026-10-16'}),
      donor({reservation_id:'far',stock_batch_id:'b2',stock_level_id:'l2',protected_due_date:'2026-11-30'})]);
    expect(result.rows[0]).toMatchObject({reservation_id:'far',proposed_quantity:'8',protected_due_date:'2026-11-30'});
    expect(result.rows[1].proposed_quantity).toBe('0');
  });
  it('handles decimals exactly and conserves requested = free + recovery + shortage', () => {
    const result=plan([donor({reservation_remaining:'0.2'})],'0.3','0.1');
    expect(result).toMatchObject({requested_quantity:'0.3',free_quantity:'0.1',recovery_quantity:'0.2',shortage_quantity:'0'});
  });
  it('rejects duplicate reservations and inconsistent reserved counters', () => {
    expect(()=>plan([donor(),donor()])).toThrow(/plusieurs fois/);
    expect(()=>plan([donor({batch_reserved:'9'})])).toThrow(/dépassent/);
    expect(()=>plan([donor({level_reserved:'9'})])).toThrow(/dépassent/);
  });
  it('rejects an excessive quantity, a zero quantity and malformed numeric evidence', () => {
    expect(()=>plan([donor()],'11')).toThrow(/besoin non couvert/);
    expect(()=>plan([donor()],'0')).toThrow(/besoin non couvert/);
    expect(()=>plan([donor({batch_total:'NaN'})])).toThrow(/doivent être vérifiées/);
  });
});
