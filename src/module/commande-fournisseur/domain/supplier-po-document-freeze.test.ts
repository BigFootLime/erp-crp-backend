import {describe,it,expect} from 'vitest';
import {supplierDocumentFreezeRequestKey} from './supplier-po-document-freeze';
describe('supplier document freeze retries',()=>{
  it('uses a stable key for the same source token and reason',()=>{
    expect(supplierDocumentFreezeRequestKey('order','2026-10-13 09:00:00+02','Revision'))
      .toBe(supplierDocumentFreezeRequestKey('order','2026-10-13 09:00:00+02',' Revision '));
  });
  it.each([['another','token','reason'],['order','new-token','reason'],['order','token','new-reason']])('isolates order/source/revision %s %s %s',(order,token,reason)=>{
    expect(supplierDocumentFreezeRequestKey(order,token,reason)).not.toBe(supplierDocumentFreezeRequestKey('order','token','reason'));
  });
  it.each([undefined,'',' '])('does not guess a replay for a caller without a source token (%s)',token=>{
    expect(supplierDocumentFreezeRequestKey('order',token,undefined)).toBeNull();
  });
});
