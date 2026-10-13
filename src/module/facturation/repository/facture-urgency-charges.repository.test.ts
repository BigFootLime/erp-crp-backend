import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readInvoiceUrgencyChargesTx } from './facture-urgency-charges.repository';
const charge = {id:'charge',commande_id:'10',numero:'CC10',client_id:'C1',amount_ht:'35.50',currency:'EUR',tax_rate_percent:'20.0000',settings_version:2};
const query=vi.fn(),tx={query};
const args={orderIds:['10','10'],clientId:'C1',currency:'EUR',lock:true};
beforeEach(()=>{query.mockReset();});
describe('one automatic invoice charge per order',()=>{
  it('deduplicates selected orders and computes an independent service line with exact totals',async()=>{
    query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[charge]});
    expect(await readInvoiceUrgencyChargesTx(tx,args)).toEqual([expect.objectContaining({
      source_type:'ORDER_CHARGE',source_id:'10',source_line_id:'charge',quantity:'1.000',
      total_ex_tax:'35.50',tax_amount:'7.10',total_incl_tax:'42.60',rule_code:'URGENCY_ONCE_PER_ORDER',
    })]);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[0][1]).toEqual([['10']]);
    expect(query.mock.calls[1][1]).toEqual([['10'],null]);
  });
  it('rereads invoice ownership after waiting for a competing draft to claim the charge',async()=>{
    let claimed=false;
    query.mockImplementation(async(sql:string)=>{
      if(sql.includes('FOR UPDATE')) {claimed=true;return {rows:[{id:'charge'}]};}
      return {rows:claimed?[]:[charge]};
    });
    expect(await readInvoiceUrgencyChargesTx(tx,args)).toEqual([]);
    expect(query.mock.calls).toHaveLength(2);
  });
  it('revalidates an existing invoice using only its accepted binding',async()=>{
    query.mockResolvedValue({rows:[charge]});
    await readInvoiceUrgencyChargesTx(tx,{...args,lock:false,invoiceId:4});
    expect(query.mock.calls[0][1]).toEqual([['10'],4]);
    expect(query.mock.calls[0][0]).toContain('binding.facture_id=$2::bigint');
  });
  it.each([{client_id:'C2'},{currency:'USD'}])('rejects changing the accepted billing scope (%j)',async changed=>{
    query.mockResolvedValue({rows:[{...charge,...changed}]});
    await expect(readInvoiceUrgencyChargesTx(tx,{...args,lock:false})).rejects.toMatchObject({code:'URGENCY_INVOICE_SCOPE_MISMATCH'});
  });
  it('does not query charges for an empty source selection',async()=>{
    expect(await readInvoiceUrgencyChargesTx(tx,{...args,orderIds:[]})).toEqual([]); expect(query).not.toHaveBeenCalled();
  });
});
