import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({reserve:vi.fn(),audit:vi.fn()}));
vi.mock('../../stock/repository/stock-reservation.repository',()=>({repoCreateStockReservation:m.reserve}));
vi.mock('./production-preparation.repository',()=>({preparationAudit:m.audit}));
import {transferMaterialReceiptTx} from './of-material-receipts.repository';
beforeEach(()=>vi.clearAllMocks());

it('preserves allocation intervals when a previous need is kept separately',async()=>{
  m.reserve.mockResolvedValue({reservation:{id:'reservation'}});
  const allocations=[{id:'previous',material_need_id:'old',of_id:1,assigned:20,kept_separate:true,transferred:0},
    {id:'current',material_need_id:'new',of_id:2,assigned:20,kept_separate:false,transferred:0,article_id:'article',unit:'u'}];
  const tx={query:vi.fn(async(sql:string)=>{
    if(sql.startsWith('SELECT s.id'))return {rows:[{id:'receipt',qty:30,line_id:'line',article_id:'article',lot_id:'lot',unite:'u',movement_status:'POSTED',dst_magasin_id:'store',dst_emplacement_id:1,receipt_start:0}]};
    if(sql.startsWith('SELECT b.id'))return {rows:allocations};
    if(sql.startsWith('SELECT COALESCE(sum'))return {rows:[{qty:0}]};
    return {rows:[]};
  })};
  const result=await transferMaterialReceiptTx(tx as never,'receipt',{user_id:1} as never);
  expect(result).toEqual([{ofId:2,reservationId:'reservation',quantity:10}]);
  expect(m.reserve).toHaveBeenCalledTimes(1);
  expect(m.reserve.mock.calls[0][0]).toMatchObject({qty:10,source:{of_id:2}});
});

it('allocates a mapped MP portion across OF needs and leaves supplier overpack in general stock',async()=>{
  m.reserve.mockImplementation(async(body)=>({reservation:{id:`reservation-${body.source.of_id}`}}));
  const allocations=[{id:'a',material_need_id:'need-a',of_id:1,assigned:40,receipt_offset:0,transferred:30,article_id:'finished-piece',unit:'u'},
    {id:'b',material_need_id:'need-b',of_id:2,assigned:20,receipt_offset:40,transferred:0,article_id:'finished-piece',unit:'u'}];
  const tx={query:vi.fn(async(sql:string)=>{
    if(sql.startsWith('SELECT s.id'))return {rows:[{id:'receipt',qty:50,line_id:'purchase-line',source_article_id:'finished-piece',article_id:'mp',lot_id:'mp-portion',unite:'u',movement_status:'POSTED',dst_magasin_id:'store',dst_emplacement_id:1,receipt_start:30}]};
    if(sql.startsWith('SELECT b.id'))return {rows:allocations};
    if(sql.startsWith('SELECT COALESCE(sum'))return {rows:[{qty:0}]};
    return {rows:[]};
  })};
  const result=await transferMaterialReceiptTx(tx as never,'receipt',{user_id:1} as never,'portion');
  expect(result.map(r=>r.quantity)).toEqual([10,20]);
  expect(m.reserve.mock.calls.map(call=>call[0])).toEqual([
    expect.objectContaining({article_id:'mp',lot_id:'mp-portion',qty:10,source:{source_type:'OF',of_id:1}}),
    expect.objectContaining({article_id:'mp',lot_id:'mp-portion',qty:20,source:{source_type:'OF',of_id:2}})
  ]);
  expect(m.reserve.mock.calls.map(call=>call[2])).toEqual(['material-receipt:receipt:a:portion','material-receipt:receipt:b:portion']);
  expect(tx.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO public.of_material_receipt_transfers'))).toHaveLength(2);
});
