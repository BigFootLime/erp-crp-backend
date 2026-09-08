import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({reserve:vi.fn(),audit:vi.fn()}));
vi.mock('../../stock/repository/stock-reservation.repository',()=>({repoCreateStockReservation:m.reserve}));
vi.mock('./production-preparation.repository',()=>({preparationAudit:m.audit}));
import {transferCustomerMaterialReceiptTx} from './customer-material-receipts.repository';
const audit={user_id:1} as never;
function receipt(){return {call_id:'call',client_id:'client',need_id:'need',of_id:19,unit:'u',article_id:'article',superseded_at:null as string|null,status:'POSTED',qty:15,unite:'u',received_article:'article',dst_magasin_id:'store',dst_emplacement_id:1,lot_id:'lot',client_proprietaire_id:'client'};}
let row:ReturnType<typeof receipt>,replayed:boolean,tx:{query:ReturnType<typeof vi.fn>};
beforeEach(()=>{
  vi.resetAllMocks();row=receipt();replayed=false;m.reserve.mockResolvedValue({reservation:{id:'reservation'}});
  tx={query:vi.fn(async(sql:string)=>sql.startsWith('SELECT c.id')?{rows:[row]}:sql.startsWith('SELECT 1 FROM public.of_customer_material_receipt_transfers')?{rowCount:replayed?1:0,rows:[]}:{rows:[]})};
});
describe('customer receipt allocation',()=>{
  it('reserves exactly the released physical receipt for its existing OF need',async()=>{
    const result=await transferCustomerMaterialReceiptTx(tx as never,'receipt',audit);
    expect(result).toEqual([{ofId:19,reservationId:'reservation',quantity:15}]);
    expect(m.reserve).toHaveBeenCalledWith(expect.objectContaining({qty:15,lot_id:'lot',source:{source_type:'OF',of_id:19}}),audit,'customer-material-receipt:receipt',tx,'need');
    expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO public.of_customer_material_receipt_transfers'),['receipt','call','reservation']);
  });
  it('does not reserve the same receipt twice',async()=>{replayed=true;expect(await transferCustomerMaterialReceiptTx(tx as never,'receipt',audit)).toEqual([]);expect(m.reserve).not.toHaveBeenCalled();});
  it.each(['owner','unit','article','unposted','superseded'])('refuses an incompatible %s before any reservation',async(kind)=>{
    if(kind==='owner')row.client_proprietaire_id='other';
    if(kind==='unit')row.unite='mm';
    if(kind==='article')row.received_article='other';
    if(kind==='unposted')row.status='DRAFT';
    if(kind==='superseded')row.superseded_at='2026-09-08';
    await expect(transferCustomerMaterialReceiptTx(tx as never,'receipt',audit)).rejects.toMatchObject({code:'CUSTOMER_MATERIAL_RECEIPT_MISMATCH'});expect(m.reserve).not.toHaveBeenCalled();
  });
});
