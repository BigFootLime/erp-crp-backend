import { describe, expect, it } from 'vitest';
import { buildUrgencyRecoveries } from './delivery-urgency-request';
import { deliveryUrgencyBody, deliveryUrgencyQuery } from '../validators/delivery-urgency.validators';
const source = (reservation_id: string, allocation_id: number, proposed_quantity: string, date='2026-11-30') =>
  ({ reservation_id, allocation_id, proposed_quantity, protected_due_date: date });
const preview = { requested_quantity:'5', free_quantity:'0', shortage_quantity:'0', recovery_quantity:'5',
  donors:[source('r1',2,'2'),source('r2',2,'3')] };
describe('urgency recovery preparation', () => {
  it('creates one recovery per donor affair, combining its stock lots', () => {
    expect(buildUrgencyRecoveries(preview)).toEqual([{ allocation_id:2, quantity:'5', due_date:'2026-11-30', sources:preview.donors }]);
  });
  it('keeps different donor affairs separate and protects their earliest deadline', () => {
    const result=buildUrgencyRecoveries({ ...preview,donors:[source('r1',2,'1'),source('r2',2,'2','2026-11-20'),source('r3',3,'2')] });
    expect(result.map(({allocation_id,quantity,due_date})=>({allocation_id,quantity,due_date})))
      .toEqual([{allocation_id:2,quantity:'3',due_date:'2026-11-20'},{allocation_id:3,quantity:'2',due_date:'2026-11-30'}]);
  });
  it('does not create a recovery before available free stock is reserved', () => {
    expect(()=>buildUrgencyRecoveries({...preview,free_quantity:'1'})).toThrow(/stock libre/);
  });
  it('does not silently fulfil only part of the requested urgency', () => {
    expect(()=>buildUrgencyRecoveries({...preview,shortage_quantity:'1'})).toThrow(/ne couvre pas/);
    expect(()=>buildUrgencyRecoveries({...preview,recovery_quantity:'4'})).toThrow(/exactement/);
    expect(()=>buildUrgencyRecoveries({...preview,donors:[source('r1',2,'4')]})).toThrow(/somme/);
  });
  it('preserves exact fractional quantities', () => {
    expect(buildUrgencyRecoveries({...preview,requested_quantity:'0.3',recovery_quantity:'0.3',
      donors:[source('r1',2,'0.1'),source('r2',2,'0.2')]})).toMatchObject([{quantity:'0.3'}]);
  });
  it.each(['0','-1','1e2','NaN','1.0001','01',' 1','1000000000'])('rejects an invalid API quantity %s', quantity => {
    expect(deliveryUrgencyQuery.safeParse({quantity}).success).toBe(false);
  });
  it('accepts a positive fractional quantity and rejects caller-supplied withdrawal permission', () => {
    const body={quantity:'0.001',preview_hash:'a'.repeat(64),reason:'Besoin urgent confirmé'};
    expect(deliveryUrgencyBody.safeParse(body).success).toBe(true);
    expect(deliveryUrgencyBody.safeParse({...body,can_withdraw:true}).success).toBe(false);
  });
});
