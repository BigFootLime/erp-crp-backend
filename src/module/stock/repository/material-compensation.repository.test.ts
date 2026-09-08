import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({get:vi.fn(),create:vi.fn(),post:vi.fn(),lock:vi.fn()}));
vi.mock('./stock.repository',()=>({repoGetMovement:m.get,repoCreateMovement:m.create,repoPostMovement:m.post,lockStockStates:m.lock,stockTargetKey:()=> 'stock'}));
import {compensateMaterialMovementTx,restoreMaterialReservationTx} from './material-compensation.repository';
const tx={query:vi.fn()},audit={user_id:1} as never;
const input={movementId:'original',ofId:19,kind:'SOURCE' as const,key:'key',reason:'Correction complète du débit constaté'};
let used=false,existing=false,expired=false;
beforeEach(()=>{vi.resetAllMocks();used=false;existing=false;expired=false;
  m.get.mockResolvedValue({movement:{status:'POSTED',movement_type:'OUT'},lines:[{article_id:'article',lot_id:'lot',qty:6,unite:'m',src_magasin_id:'warehouse',src_emplacement_id:1}]});
  m.create.mockResolvedValue({movement:{id:'inverse'}});m.post.mockResolvedValue({movement:{status:'POSTED'}});m.lock.mockResolvedValue(new Map([['stock',{qty_on_hand:6,qty_reserved:0,qty_depreciated:0}]]));
  tx.query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT m.id')?[{id:'original'}]:sql.startsWith('SELECT id FROM public.stock_movements')?(existing?[{id:'already'}]:[]):
    sql.startsWith('SELECT 1 FROM public.stock_lot_genealogy_edges')?(used?[{id:'used'}]:[]):sql.startsWith('SELECT b.stock_level_id')?[{stock_level_id:'level',stock_batch_id:'batch',qty_consumed:6,status:'CONSUMED',unexpired:!expired}]:[]}));
});
it('creates and posts an inverse source entry with a reversal link in the caller transaction',async()=>{
  await compensateMaterialMovementTx(tx as never,input,audit);
  expect(m.create).toHaveBeenCalledWith(expect.objectContaining({movement_type:'IN',source_document_type:'STOCK_COMPENSATION',lines:[expect.objectContaining({qty:6,dst_emplacement_id:1})]}),audit,{client:tx,trusted_source_flow:true});
  expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('SET reversal_of_id'),['inverse','original']);expect(m.post.mock.calls[0][4]).toBe(tx);
});
it('does not compensate an already reversed entry',async()=>{existing=true;
  await expect(compensateMaterialMovementTx(tx as never,input,audit)).rejects.toMatchObject({code:'MATERIAL_MOVEMENT_ALREADY_CORRECTED'});expect(m.create).not.toHaveBeenCalled();
});
it('refuses to remove a remnant that has moved or been reserved',async()=>{used=true;m.get.mockResolvedValue({movement:{status:'POSTED',movement_type:'IN'},lines:[{lot_id:'remnant',qty:2}]});
  await expect(compensateMaterialMovementTx(tx as never,{...input,kind:'REMNANT'},audit)).rejects.toMatchObject({code:'MATERIAL_REMNANT_ALREADY_USED'});expect(m.create).not.toHaveBeenCalled();
});
it('restores the consumed reservation and physical reserved balance without rewriting its original quantity',async()=>{
  await restoreMaterialReservationTx(tx as never,{reservationId:'res',quantity:6,reason:input.reason},audit);
  expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('qty_consumed=qty_consumed-$2'),['res',6,1,input.reason]);
  expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE public.stock_batches SET qty_reserved=qty_reserved+$2'),['batch',6]);
});
it('does not renew an expired reservation implicitly',async()=>{expired=true;
  await expect(restoreMaterialReservationTx(tx as never,{reservationId:'res',quantity:6,reason:input.reason},audit)).rejects.toMatchObject({code:'MATERIAL_RESERVATION_NOT_RESTORABLE'});expect(m.lock).not.toHaveBeenCalled();
});
