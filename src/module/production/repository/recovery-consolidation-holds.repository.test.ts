import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {AuditContext} from './production.repository';
import type {HoldRow} from './consolidation-material-holds.repository';
const mocks=vi.hoisted(()=>({material:vi.fn(),stock:vi.fn(),assertStock:vi.fn()}));
vi.mock('./recovery-consolidation-material.repository',()=>({readRecoveryConsolidationMaterialTx:mocks.material}));
vi.mock('../../stock/repository/stock.repository',()=>({lockStockStates:mocks.stock,assertStockConsumptionAllowed:mocks.assertStock,
  stockTargetKey:({stock_level_id,stock_batch_id}:any)=>`${stock_level_id}:${stock_batch_id??'-'}`}));
import {appendRecoveryConsolidationHoldsTx} from './recovery-consolidation-holds.repository';
import {restoreConsolidationHoldsTx} from './consolidation-material-holds.repository';

const input={consolidationId:'group',recoveryId:'recovery',producerId:10,recoveryOfId:20,materialVersion:'version'};
const audit={user_id:1} as AuditContext;
const row=(id:string,of_id:number,qty:number):HoldRow=>({id,of_id,article_id:'steel',location_id:'store',lot_id:'lot',stock_batch_id:'batch',
  stock_level_id:'level',qty_reserved:qty,qty_consumed:0,qty_prepared:0,source_type:'OF',source_id:String(of_id),
  material_need_id:`need${of_id}`,status:'ACTIVE',unexpired:true});
let rows:HoldRow[],evidence:any[],proof:any[],transfers:any[],baseWrites:any[],context:boolean,existing:boolean,query:ReturnType<typeof vi.fn>,tx:PoolClient;
const writes=()=>query.mock.calls.filter(([sql])=>/^\s*(UPDATE|INSERT)/.test(sql));
beforeEach(()=>{
  vi.resetAllMocks();rows=[{...row('target',10,100),qty_consumed:40,qty_prepared:5},row('source',20,12.125)];
  evidence=[{producer_reservation_id:'target',producer_need_id:'need10',total_reserved:100}];
  proof=[];transfers=[];baseWrites=[];context=true;existing=false;
  mocks.material.mockResolvedValue({ready:true,version:'version',groups:[{producer_need_id:'need10',recovery_need_id:'need20',article_id:'steel',recovery_reservation_ids:['source']}]});
  mocks.stock.mockResolvedValue(new Map([['level:batch',{qty_reserved:100}],['level:-',{qty_reserved:100}]]));
  query=vi.fn(async(sql:string,p:any[]=[])=>{
    if(sql.includes('AS valid'))return {rows:[{valid:context}]};
    if(sql.includes('WHERE recovery_id=$1'))return {rows:existing?[{reservation_id:'source'}]:[]};
    if(sql.startsWith('SELECT id::text FROM public.stock_reservations'))return {rows:rows.map(r=>({id:r.id}))};
    if(sql.startsWith('SELECT l.id'))return {rows:[]};
    if(sql.startsWith('SELECT r.id::text'))return {rows:structuredClone(rows)};
    if(sql.includes('AS total_reserved'))return {rows:evidence};
    if(sql.startsWith('UPDATE public.stock_reservations SET qty_reserved')){rows.find(r=>r.id===p[0])!.qty_reserved+=p[1];return {rows:[]};}
    if(sql.startsWith('INSERT INTO public.stock_reservations')){rows.push({...rows.find(r=>r.id===p[0])!,id:'new',of_id:p[1],source_id:String(p[1]),material_need_id:p[2]});return {rows:[{id:'new'}]};}
    if(sql.startsWith('INSERT INTO public.production_consolidation_material_holds')){baseWrites.push(p);return {rows:[]};}
    if(sql.startsWith('INSERT INTO public.production_consolidation_material_transfers')){transfers.push(p);return {rows:[]};}
    if(sql.startsWith('UPDATE public.stock_reservations SET status')){rows.find(r=>r.id===p[0])!.status='RELEASED';return {rows:[]};}
    if(sql.startsWith('INSERT INTO public.production_recovery_material_extensions')){proof.push(p);return {rows:[]};}
    throw new Error(`Unexpected query ${sql}`);
  });tx={query} as unknown as PoolClient;
});

describe('recovery material transfer to an active producer',()=>{
  it('extends the same physical hold while preserving consumed and prepared quantities',async()=>{
    expect(await appendRecoveryConsolidationHoldsTx(tx,input,audit)).toEqual([{source_reservation_id:'source',producer_reservation_id:'target',quantity:12.125}]);
    expect(rows[0]).toMatchObject({qty_reserved:112.125,qty_consumed:40,qty_prepared:5});
    expect(rows[1]).toMatchObject({status:'RELEASED',qty_reserved:12.125,qty_consumed:0});
    expect(baseWrites).toHaveLength(0);
    expect(proof).toEqual([['group','source','recovery','target',12.125,false,100,40,5,1]]);
    expect(transfers[0]).toEqual(['group','source',20,'need20','need10','target',12.125]);
    expect(writes().some(([sql])=>/UPDATE public.stock_(levels|batches)|stock_movements/.test(sql))).toBe(false);
  });
  it('creates a new hold for a different batch without double-counting the original ledger',async()=>{
    rows[0].lot_id='other';rows[0].stock_batch_id='otherBatch';
    await appendRecoveryConsolidationHoldsTx(tx,input,audit);
    expect(rows[0].qty_reserved).toBe(100);expect(baseWrites).toEqual([['group','new','need10',12.125]]);
    expect(proof[0]).toEqual(['group','source','recovery','new',12.125,true,0,0,0,1]);
  });
  it('includes earlier extensions when matching an existing hold',async()=>{
    evidence[0].total_reserved=112;rows[0].qty_reserved=112;
    await appendRecoveryConsolidationHoldsTx(tx,input,audit);expect(rows[0].qty_reserved).toBe(124.125);
  });
  it.each(['consumed','prepared','expired','wrongOf','wrongNeed','wrongArticle','released'])('rejects an altered recovery hold: %s',async(kind)=>{
    const s=rows[1];if(kind==='consumed')s.qty_consumed=1;if(kind==='prepared')s.qty_prepared=1;
    if(kind==='expired')s.unexpired=false;if(kind==='wrongOf')s.of_id=30;if(kind==='wrongNeed')s.material_need_id='other';
    if(kind==='wrongArticle')s.article_id='other';if(kind==='released')s.status='RELEASED';
    await expect(appendRecoveryConsolidationHoldsTx(tx,input,audit)).rejects.toMatchObject({code:'RECOVERY_MATERIAL_CHANGED'});
    expect(writes()).toHaveLength(0);
  });
  it.each(['missingLedger','unexplainedQuantity','expired','batchMismatch','duplicate'])('rejects altered producer coverage: %s',async(kind)=>{
    if(kind==='missingLedger')evidence=[];if(kind==='unexplainedQuantity')rows[0].qty_reserved++;
    if(kind==='expired')rows[0].unexpired=false;if(kind==='batchMismatch')rows[0].stock_batch_id='unknown';
    if(kind==='duplicate')rows.push({...rows[0],id:'duplicate'});
    await expect(appendRecoveryConsolidationHoldsTx(tx,input,audit)).rejects.toMatchObject({code:'RECOVERY_MATERIAL_CHANGED'});
    expect(writes()).toHaveLength(0);
  });
  it('rechecks quality and material origins after acquiring the physical locks',async()=>{
    mocks.material.mockResolvedValueOnce({ready:true,version:'version'}).mockResolvedValueOnce({ready:false,version:'version'});
    await expect(appendRecoveryConsolidationHoldsTx(tx,input,audit)).rejects.toMatchObject({code:'RECOVERY_MATERIAL_CHANGED'});
    expect(writes()).toHaveLength(0);
    const calls=query.mock.calls.map(([sql])=>sql);
    expect(calls.findIndex(s=>s.startsWith('SELECT l.id'))).toBeLessThan(calls.findIndex(s=>s.includes('FOR UPDATE OF r')));
  });
  it('refuses stale material, a repeated transfer and inactive context',async()=>{
    await expect(appendRecoveryConsolidationHoldsTx(tx,{...input,materialVersion:'old'},audit)).rejects.toMatchObject({code:'RECOVERY_MATERIAL_CHANGED'});
    existing=true;await expect(appendRecoveryConsolidationHoldsTx(tx,input,audit)).rejects.toMatchObject({code:'RECOVERY_MATERIAL_CHANGED'});
    existing=false;context=false;await expect(appendRecoveryConsolidationHoldsTx(tx,input,audit)).rejects.toMatchObject({code:'RECOVERY_MATERIAL_CHANGED'});
    expect(writes()).toHaveLength(0);
  });
  it('refuses an under-backed physical stock before any mutation',async()=>{
    mocks.assertStock.mockImplementation(()=>{throw new Error('Stock underflow');});
    await expect(appendRecoveryConsolidationHoldsTx(tx,input,audit)).rejects.toThrow('Stock underflow');expect(writes()).toHaveLength(0);
  });
  it('supports an assembly with no direct material',async()=>{
    rows=[];mocks.material.mockResolvedValue({ready:true,version:'version',groups:[]});
    expect(await appendRecoveryConsolidationHoldsTx(tx,input,audit)).toEqual([]);expect(writes()).toHaveLength(0);
  });
});

describe('dissolution after a recovery addition',()=>{
  it('restores each original hold and releases only true surplus',async()=>{
    rows=[row('target',10,115),{...row('initial',1,100),status:'RELEASED'}, {...row('source',20,12),status:'RELEASED'}];
    query.mockImplementation(async(sql:string,p:any[]=[])=>{
      if(sql.includes('AS transferred_qty'))return {rows:[{producer_reservation_id:'target',producer_need_id:'need10',transferred_qty:'112',surplus_qty:'3'}]};
      if(sql.startsWith('SELECT reservation_id::text'))return {rows:[{reservation_id:'initial',producer_reservation_id:'target',source_reserved_qty:'100',source_of_id:1,source_need_id:'need1'},
        {reservation_id:'source',producer_reservation_id:'target',source_reserved_qty:'12',source_of_id:20,source_need_id:'need20'}]};
      if(sql.startsWith('SELECT r.id::text'))return {rows};
      return {rows:[]};
    });
    await restoreConsolidationHoldsTx(tx,'group',10,audit);
    const deltas=query.mock.calls.filter(([sql])=>/UPDATE public.stock_(levels|batches)/.test(sql));
    expect(deltas).toHaveLength(2);expect(deltas.map(([,p])=>p[1])).toEqual([3,3]);
    expect(query.mock.calls.find(([sql])=>sql.includes("SET status='ACTIVE'"))?.[1][0]).toEqual(['initial','source']);
    rows[0].qty_consumed=1;query.mockClear();
    await expect(restoreConsolidationHoldsTx(tx,'group',10,audit)).rejects.toMatchObject({code:'CONSOLIDATION_MATERIAL_CHANGED'});
    expect(writes()).toHaveLength(0);
  });
});
