import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({reserve:vi.fn(),audit:vi.fn(),customer:vi.fn()}));
vi.mock('../../stock/repository/stock-reservation.repository',()=>({repoCreateStockReservation:m.reserve}));
vi.mock('./production-preparation.repository',()=>({preparationAudit:m.audit}));
vi.mock('./customer-material-receipts.repository',()=>({transferCustomerMaterialReceiptTx:m.customer}));
import {transferMaterialReceiptTx} from './of-material-receipts.repository';
beforeEach(()=>{vi.clearAllMocks();m.reserve.mockResolvedValue({reservation:{id:'reservation'}})});
function fixture(start:number,qty:number,offset:number,assigned:number,here=0){
  const tx={query:vi.fn(async(sql:string)=>{
    if(sql.includes('receipt_start'))return {rows:[{line_id:'line',qty,receipt_start:start,movement_status:'POSTED',article_id:'article',lot_id:'lot',unite:'m',dst_magasin_id:'store',dst_emplacement_id:1}]};
    if(sql.includes('FOR UPDATE OF b'))return {rows:[{id:'allocation',material_need_id:'need',of_id:20,article_id:'article',unit:'m',assigned,receipt_offset:offset,transferred:here}]};
    if(sql.includes('sum(r.qty_reserved)'))return {rows:[{qty:here}]};
    return {rows:[]};
  })};return tx;
}
describe('posting future allocations after prior receipts',()=>{
  it('assigns the full new receipt even when earlier unassigned material is quarantined',async()=>{
    const tx=fixture(20,30,20,30);const result=await transferMaterialReceiptTx(tx as never,'receipt',{user_id:1} as never);
    expect(result[0].quantity).toBe(30);expect(m.reserve.mock.calls[0][0].qty).toBe(30);
    expect(m.reserve.mock.calls[0][3]).toBe(tx);
  });
  it('leaves stock received before the promise unallocated',async()=>{
    expect(await transferMaterialReceiptTx(fixture(0,20,20,30) as never,'receipt',{user_id:1} as never)).toEqual([]);
    expect(m.reserve).not.toHaveBeenCalled();
  });
  it('does not reserve twice on replay',async()=>{
    expect(await transferMaterialReceiptTx(fixture(20,30,20,30,30) as never,'receipt',{user_id:1} as never)).toEqual([]);
    expect(m.reserve).not.toHaveBeenCalled();
  });
});
