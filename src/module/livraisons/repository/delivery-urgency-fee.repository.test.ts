import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptedUrgencyFee } from '../domain/urgency-order-fee';
import { readDeliveryUrgencyFeeTx, recordDeliveryUrgencyFeeTx } from './delivery-urgency-fee.repository';
const fee = { amount_ht:'35.50', currency:'EUR', tax_rate_percent:'20.0000', settings_version:2 };
const query = vi.fn(); const tx = {query};
beforeEach(() => { query.mockReset(); });
describe('accepted urgency order price', () => {
  it.each([null, {}, {...fee,amount_ht:35.5}, {...fee,amount_ht:'-1'}, {...fee,tax_rate_percent:'101'}, {...fee,settings_version:0}])
    ('rejects unknown or invalid prices rather than inventing a default (%j)', value => {
      expect(() => acceptedUrgencyFee(value)).toThrowError(expect.objectContaining({code:'URGENCY_FEE_REQUIRED'}));
    });
  it('retains exact decimals and permits explicitly free urgency', () => {
    expect(acceptedUrgencyFee({...fee,amount_ht:'0',tax_rate_percent:'5.5'})).toMatchObject({amount_ht:'0.00',tax_rate_percent:'5.5000'});
  });
  it('returns the accepted fee after the client tariff has changed', async () => {
    query.mockResolvedValue({rows:[{frozen_fee:fee,amount_ht:'100.00',currency:'EUR',client_currency:'EUR',tax_rate_percent:'10',settings_version:3,charged:false}]});
    expect(await readDeliveryUrgencyFeeTx(tx,1,'request')).toEqual({fee,charged:false,blocker:null});
    expect(query.mock.calls[0][1]).toEqual([1,'request']);
  });
  it('reports missing configuration and a changed client currency as actionable blockers', async () => {
    query.mockResolvedValueOnce({rows:[{frozen_fee:null,amount_ht:null,charged:false}]});
    expect(await readDeliveryUrgencyFeeTx(tx,1)).toMatchObject({fee:null,blocker:expect.any(String)});
    query.mockResolvedValueOnce({rows:[{...fee,frozen_fee:null,client_currency:'USD',charged:false}]});
    expect(await readDeliveryUrgencyFeeTx(tx,1)).toMatchObject({fee:null,blocker:expect.stringContaining('devise')});
  });
  it('reuses the single order charge across different requests without inserting again', async () => {
    query.mockImplementation(async (sql:string) => ({rows:sql.includes('AS fee') ? [{commande_id:'10',client_id:'C1',fee}]
      : sql.includes('FROM public.delivery_urgency_order_charges') ? [{id:'charge',...fee}] : []}));
    expect(await recordDeliveryUrgencyFeeTx(tx,{requestId:'second',withdrawalId:'withdrawal2',actor:8}))
      .toEqual({id:'charge',already_applied:true});
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });
  it('refuses a conflicting fee already accepted by another request on the same order', async () => {
    query.mockImplementation(async (sql:string) => ({rows:sql.includes('AS fee') ? [{commande_id:'10',client_id:'C1',fee}]
      : sql.includes('FROM public.delivery_urgency_order_charges') ? [{id:'charge',...fee,amount_ht:'99.00'}] : []}));
    await expect(recordDeliveryUrgencyFeeTx(tx,{requestId:'second',withdrawalId:'withdrawal2',actor:8}))
      .rejects.toMatchObject({code:'URGENCY_ORDER_FEE_CHANGED'});
  });
  it('persists accepted values rather than rereading the new client tariff', async () => {
    query.mockImplementation(async (sql:string) => ({rows:sql.includes('AS fee') ? [{commande_id:'10',client_id:'C1',fee}]
      : sql.includes('INSERT') ? [{id:'charge'}] : []}));
    expect(await recordDeliveryUrgencyFeeTx(tx,{requestId:'request',withdrawalId:'withdrawal',actor:8})).toEqual({id:'charge',already_applied:false});
    expect(query.mock.calls.find(([sql])=>sql.includes('INSERT'))?.[1])
      .toEqual(['10','C1','request','withdrawal','35.50','EUR','20.0000',2,8]);
  });
});
