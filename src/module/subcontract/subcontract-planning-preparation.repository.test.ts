import {describe,it,expect,vi} from 'vitest';
import {readExternalPreparationsTx} from './subcontract-planning-preparation.repository';
const id='bb693a40-3090-4703-b727-d4691097b177',purchase='8a8502a7-df5e-409d-bc85-ac9efad7e18b',catalogue='7d94f0a9-7f34-433f-b3af-c18fa5b21841';
const row=()=>({id:'prep',operation_id:id,purchase_id:purchase,quantity:120,packaged_quantity:100,supplier_active:true,
  snapshot:{service:{selection:{operationId:id,purchaseId:purchase,catalogueId:catalogue,destinationId:null,due:null},forecastQuantity:120}},
  catalogue_id:catalogue,supplier_id:'supplier',supplier_name:'Traitement',unit:'U',delay:3,order_line_ids:['line'],updated_at:'2026-10-12'});
function db(rows= [row()],installed=true){const query=vi.fn();query.mockImplementation(async(sql:string)=>({rows:sql.includes('to_regclass')?[{installed}]:sql.includes('AS required_purchase')?[]:rows}));return {query};}
describe('canonical saved supplier selections for planning',()=>{
  it('reads visible operations in one batch and does not manufacture work packages',async()=>{
    const tx=db();const result=await readExternalPreparationsTx(tx,[id]);
    expect(result.get(id)).toMatchObject({issues:[],preparations:[{quantity:120,leadDays:3,due:null,orderLineIds:['line']}]});
    expect(tx.query).toHaveBeenCalledTimes(3);expect(tx.query.mock.calls.every(([sql])=>sql.trimStart().startsWith('SELECT'))).toBe(true);
  });
  it('requires the saved quantity to match the current OF, and fingerprints the selected conditions',async()=>{
    const stale=row();stale.snapshot.service.forecastQuantity=100;
    expect((await readExternalPreparationsTx(db([stale]),[id])).get(id)?.issues).toHaveLength(1);
    const first=(await readExternalPreparationsTx(db(),[id])).get(id)!.preparations[0];
    const changed=row();changed.delay=7;
    expect((await readExternalPreparationsTx(db([changed]),[id])).get(id)!.preparations[0].version).not.toBe(first.version);
  });
  it.each(['supplier','unit','delay','catalogue'] as const)('rejects unusable %s conditions before proposing a date',async(field)=>{
    const value=row();if(field==='supplier')value.supplier_active=false;if(field==='unit')value.unit='KG';
    if(field==='delay')value.delay=-1;if(field==='catalogue')value.catalogue_id='';
    const result=(await readExternalPreparationsTx(db([value]),[id])).get(id)!;
    expect(result.preparations).toEqual([]);expect(result.issues).toHaveLength(1);
  });
  it('does not invalidate physical coverage because the former catalogue is no longer active',async()=>{
    const value=row();value.packaged_quantity=120;value.supplier_active=false;value.catalogue_id='';value.snapshot.service.forecastQuantity=100;
    expect((await readExternalPreparationsTx(db([value]),[id])).get(id)).toMatchObject({issues:[],preparations:[{quantity:120}]});
  });
  it('does not query preparations on older schemas or for an empty selection',async()=>{
    const tx=db([],false);expect((await readExternalPreparationsTx(tx,[id])).size).toBe(0);expect(tx.query).toHaveBeenCalledOnce();
    tx.query.mockClear();expect((await readExternalPreparationsTx(tx,[])).size).toBe(0);expect(tx.query).not.toHaveBeenCalled();
  });
  it('does not hide an unprepared second service behind the first selected supplier',async()=>{
    const tx=db();const original=tx.query.getMockImplementation()!;
    tx.query.mockImplementation(async(sql:string)=>sql.includes('AS required_purchase')?{rows:[{operation_id:id,required_purchase:'second',covered:false}]}:original(sql));
    expect((await readExternalPreparationsTx(tx,[id])).get(id)?.issues).toEqual(['Complétez les prestations fournisseur de cette phase avant de planifier.']);
  });
  it('projects the extra quantity from the current saved selection without accepting expired terms',async()=>{
    const value=row();value.packaged_quantity=120;
    const result=await readExternalPreparationsTx(db([value]),[id],10);
    expect(result.get(id)?.preparations[0]).toMatchObject({quantity:130,catalogueId:catalogue});
    value.supplier_active=false;
    expect((await readExternalPreparationsTx(db([value]),[id],10)).get(id)?.preparations).toEqual([]);
  });
  it('requires a current base quantity even when the additional forecast is requested',async()=>{
    const value=row();value.snapshot.service.forecastQuantity=100;
    expect((await readExternalPreparationsTx(db([value]),[id],10)).get(id)?.issues).toHaveLength(1);
  });
});
