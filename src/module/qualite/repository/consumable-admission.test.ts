import { describe,it,expect,vi } from 'vitest';
import { assertOperationalLotQualityEligibility,assertReceiptLotQualityEligibility,recordDirectLotQualityConsumption } from './quality-operational-gate.repository';

function client(options:{admitted?:number;consumed?:number;reserved?:number;blocked?:boolean;nc?:boolean;control?:boolean}={}){
  return {query:vi.fn(async(sql:string)=>{
    if(sql.includes('FROM public.lots'))return {rows:[{lot_code:'PAL-1',lot_status:options.blocked?'BLOQUE':'LIBERE',article_unit:'U'}]};
    if(sql.includes('FROM public.quality_control qc'))return {rows:options.control?[{id:'qc',qty_released:0,qty_consumed:0,qty_held:0,unite:'U',pending:true}]:[]};
    if(sql.includes('FROM public.consumable_receipt_admissions'))return {rows:options.admitted===0?[]:[{id:'admission',quantity:options.admitted??100,unit:'U',receipt_line_id:'receipt-line',direct_consumed:options.consumed??0}]};
    if(sql.includes('FROM public.stock_reservations'))return {rows:[{qty:options.reserved??0}]};
    if(sql.includes('FROM public.non_conformity'))return {rows:[{total:options.nc?1:0}]};
    if(sql.includes('FROM public.quality_release_decision'))return {rows:[]};
    throw new Error('Unexpected quality write/query');
  })};
}
describe('dispensed consommable receipt admission',()=>{
  it('is a finite receipt entitlement with the same unit and receipt identity',async()=>{
    const tx=client();
    await expect(assertReceiptLotQualityEligibility({client:tx as never,lotId:'lot',receiptLineId:'receipt-line',qty:100,unit:'U'})).resolves.toMatchObject({evidence:{receipt_admission_ids:['admission'],control_ids:[]}});
    await expect(assertReceiptLotQualityEligibility({client:tx as never,lotId:'lot',receiptLineId:'other',qty:1,unit:'U'})).rejects.toMatchObject({code:'QUALITY_RECEIPT_CONTROL_REQUIRED'});
    await expect(assertReceiptLotQualityEligibility({client:tx as never,lotId:'lot',receiptLineId:'receipt-line',qty:101,unit:'U'})).rejects.toMatchObject({code:'QUALITY_NOT_ELIGIBLE'});
  });
  it('counts posted direct issues and reservations without inventing an inspection',async()=>{
    const tx=client({consumed:30,reserved:20});
    const decision=await assertOperationalLotQualityEligibility({client:tx as never,lotId:'lot',qty:50,unit:'U',purpose:'RESERVE'});
    await expect(recordDirectLotQualityConsumption({client:tx as never,decision,qty:50})).resolves.toBeUndefined();
    expect(tx.query.mock.calls.every(([sql])=>!sql.trim().startsWith('UPDATE'))).toBe(true);
    await expect(assertOperationalLotQualityEligibility({client:tx as never,lotId:'lot',qty:51,unit:'U',purpose:'RESERVE'})).rejects.toMatchObject({code:'QUALITY_NOT_ELIGIBLE'});
  });
  it.each([{blocked:true},{nc:true},{control:true},{admitted:0}])('keeps quality blocks authoritative: %j',async options=>{
    await expect(assertOperationalLotQualityEligibility({client:client(options) as never,lotId:'lot',qty:1,unit:'U',purpose:'RESERVE'})).rejects.toMatchObject({code:'QUALITY_NOT_ELIGIBLE'});
  });
});
