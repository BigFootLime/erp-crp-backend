import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
const ports=vi.hoisted(()=>({reserve:vi.fn(),create:vi.fn(),post:vi.fn()}));
vi.mock('../../production/repository/receipt-delivery-reservations.repository',()=>({reserveProducedDeliveryDemands:ports.reserve}));
vi.mock('../../stock/repository/stock.repository',()=>({repoCreateMovement:ports.create,repoPostMovement:ports.post}));
import { restoreUrgencyStockTx } from './urgency-restitution-stock.repository';
type Args=Parameters<typeof restoreUrgencyStockTx>[1];
function fixture() {
 const reservation={id:'held',qty_reserved:5,qty_prepared:0,qty_consumed:0,status:'ACTIVE',version:1};
 const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
  if(sql.startsWith('SELECT to_jsonb'))return {rows:[{snapshot:{...reservation}}]};
  if(sql.startsWith('UPDATE public.stock_reservations')){
   if(reservation.qty_prepared || reservation.qty_consumed || reservation.status!=='ACTIVE')return {rows:[]};
   const amount=Number(params[1]);if(amount===reservation.qty_reserved)reservation.status='RELEASED';else reservation.qty_reserved-=amount;
   reservation.version++;return {rows:[{snapshot:{...reservation}}]};
  }
  return {rowCount:1,rows:[{id:'stock'}]};
 });
 const tx={query} as unknown as PoolClient;
 const source={id:'held',article_id:'article',lot_id:'lot',location_id:'delivery',stock_level_id:'level',stock_batch_id:'batch',source_scope:'OLD',magasin_id:'warehouse',emplacement_id:1,unit:'u'};
 const args={restorationId:'return',audit:{user_id:8},review:{evidence:{reservations:[source],recoveries:[{id:'r1',commande_ligne_id:11,livraison_affaire_id:12},{id:'r2',commande_ligne_id:21,livraison_affaire_id:22}],
  routing:{destinations:[{lane:'FREE',valid:true,magasin_id:'warehouse',emplacement_id:2}]}},response:{lines:[
   {transfer_id:'t1',recovery_id:'r1',reservation_id:'held',quantity:'2',donor_quantity:'2',free_quantity:'0'},
   {transfer_id:'t2',recovery_id:'r2',reservation_id:'held',quantity:'3',donor_quantity:'1',free_quantity:'2'}]}}} as Args;
 return {tx,query,args,reservation};
}
beforeEach(()=>{vi.resetAllMocks();ports.reserve.mockImplementation(async(_tx,args)=>({reservation_id:'donor-'+args.commande_ligne_id,reservation_ids:['donor-'+args.commande_ligne_id],qty_reserved:args.qty_ok}));
 ports.create.mockResolvedValue({movement:{id:'move'}});ports.post.mockResolvedValue({movement:{id:'move',status:'POSTED'}});});
describe('stock restitution canonical writes',()=>{
 it('splits a shared reservation exactly, preserves OLD identity and posts only the surplus',async()=>{
  const {tx,query,args,reservation}=fixture();await restoreUrgencyStockTx(tx,args);
  expect(reservation).toMatchObject({status:'RELEASED',qty_reserved:3,version:3});
  expect(ports.reserve).toHaveBeenNthCalledWith(1,tx,expect.objectContaining({commande_ligne_id:11,livraison_affaire_id:12,qty_ok:2,source_scope:'OLD',stock_batch_id:'batch'}));
  expect(ports.reserve).toHaveBeenNthCalledWith(2,tx,expect.objectContaining({commande_ligne_id:21,livraison_affaire_id:22,qty_ok:1,source_scope:'OLD'}));
  expect(ports.create).toHaveBeenCalledWith(expect.objectContaining({source_document_type:'URGENCY_RESTITUTION',source_document_id:'return',movement_type:'TRANSFER',
   lines:[expect.objectContaining({qty:2,src_emplacement_id:1,dst_emplacement_id:2,article_id:'article',lot_id:'lot'})]}),args.audit,{client:tx,trusted_source_flow:true});
  expect(ports.post).toHaveBeenCalledWith('move',{},args.audit,'urgency-restitution:return:t2:post',tx);
  const inserts=query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO public.delivery_urgency_restitution_lines'));
  expect(inserts).toHaveLength(2);
  expect(JSON.parse(String(inserts[1][1]![6]))).toMatchObject({before:{qty_reserved:3,status:'ACTIVE'},after:{qty_reserved:3,status:'RELEASED'}});
 });
 it.each(['qty_prepared','qty_consumed'] as const)('refuses %s stock before reserving or transferring it',async field=>{
  const {tx,args,reservation}=fixture();reservation[field]=1;
  await expect(restoreUrgencyStockTx(tx,args)).rejects.toMatchObject({code:'URGENCY_RETURN_CHANGED'});
  expect(ports.reserve).not.toHaveBeenCalled();expect(ports.create).not.toHaveBeenCalled();
 });
 it('does not journal stock when the donor demand has changed',async()=>{
  ports.reserve.mockResolvedValueOnce(null);const {tx,args,query}=fixture();
  await expect(restoreUrgencyStockTx(tx,args)).rejects.toMatchObject({code:'URGENCY_RETURN_DONOR_CHANGED'});
  expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
 });
 it('does not accept a draft physical transfer as returned free stock',async()=>{
  ports.post.mockResolvedValueOnce({movement:{id:'move',status:'DRAFT'}});const {tx,args,query}=fixture();
  await expect(restoreUrgencyStockTx(tx,args)).rejects.toThrow('URGENCY_RETURN_TRANSFER_NOT_POSTED');
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT'))).toHaveLength(1);
 });
});
