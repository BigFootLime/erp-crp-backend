import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({connect:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{connect:m.connect}}));
vi.mock('./of-dossier.repository',()=>({materialWorkflowEnabled:async()=>true,readOfDossierTx:async()=>({version:'dossier',number:'OF-TEST',quantity:100,status:'COMPLETE',operations:[{id:'cut',label:'Découpe',phase:10}]})}));
vi.mock('./material-future-supply.repository',()=>({readFutureMaterialSupplyTx:async()=>[]}));
vi.mock('./customer-material-read.repository',()=>({readCustomerMaterialCallsTx:async()=>[]}));
vi.mock('./material-debit-history.repository',()=>({readMaterialDebitsTx:async()=>[]}));
vi.mock('./production-preparation.repository',()=>({preparationAudit:async()=>{}}));
import {readMaterialTx,configureOfMaterial} from './of-material.repository';
const requirements={grade:'6082',condition:'T651',ownerClientId:null,dimensions:{longueur_mm:85},certificates:[],manualChecks:[]};
const rule={form:'UNIT' as const,stockUnit:'u',unitsPerBlank:1,kerfPerBlank:0,yieldValidated:true};
let disposition='CARRY';
const tx={query:vi.fn(),release:vi.fn()};
beforeEach(()=>{vi.clearAllMocks();disposition='CARRY';m.connect.mockResolvedValue(tx);
  const base={article_id:'article',operation_id:'cut',unit:'u',supply_mode:'PURCHASE',requirements,debit_rule:rule,required_qty:100,specification_reviewed_at:'reviewed',technical_hash:'hash',row_version:1,designation:'Plat alu',supplier_id:'supplier',allow_partial:true,destination_id:null};
  tx.query.mockImplementation(async(sql:string)=>({rows:
    sql.includes('AS purchases')?[{revision:'new-revision',hash:'hash',client_id:null,purchases:[{id:'new-source',article_id:'article',type_achat:'MATIERE',quantite:1,unite_prix:'u',fournisseur_id:'supplier',pu_achat:2}]}]:
    sql.startsWith('SELECT * FROM public.of_material_needs')?[{...base,id:'old',source_ref:'old-source',technical_version_id:'old-revision'},{...base,id:'current',source_ref:'new-source',technical_version_id:'new-revision'}]:
    sql.includes('FROM public.v_of_material_need_destinations')?[{source_need_id:'old',target_need_id:disposition==='CARRY'?'current':'old'},{source_need_id:'current',target_need_id:'current'}]:
    sql.includes('FROM public.of_material_revision_resolutions r')?[{id:'resolution',previous_need_id:'old',target_need_id:disposition==='CARRY'?'current':null,disposition}]:
    sql.includes('AS adjustment')?[{need_id:'old',adjustment:5}]:
    sql.includes('FROM public.stock_reservations r LEFT JOIN')?[{id:'reservation',material_need_id:'old',article_id:'article',qty_reserved:60,qty_consumed:25,status:'ACTIVE',unexpired:true}]:
    sql.startsWith('WITH allocations')?[{id:'allocation',material_need_id:'old',assigned:40,received:0,transferred:0,unite:'u'}]:
    sql.startsWith('SELECT a.id::text,a.code,a.unite')?[{id:'article',code:'ALU',unite:'u'}]:sql.startsWith('SELECT unite FROM public.articles')?[{unite:'u'}]:[]
  }));
});
it('reads original reservations, actual debit variance and promised purchases once under the new need',async()=>{
  const data=await readMaterialTx(tx as never,19);
  expect(data.previousNeeds).toHaveLength(0);expect(data.needs).toHaveLength(1);
  expect(data.needs[0]).toMatchObject({id:'current',required:105,reserved:35,consumed:25,expected:40,missing:5,consumptionAdjustment:5});
  expect(data.needs[0].reservations[0].material_need_id).toBe('old');
});
it('keeps explicitly separated historical commitments out of the new coverage',async()=>{
  disposition='KEEP_SEPARATE';const data=await readMaterialTx(tx as never,19);
  expect(data.previousNeeds).toHaveLength(0);expect(data.reconciliations[0].disposition).toBe('KEEP_SEPARATE');
  expect(data.needs[0]).toMatchObject({required:100,reserved:0,consumed:0,expected:0,missing:100});
});
it('refuses to rewrite the debit conversion after material has been consumed',async()=>{
  const current=await readMaterialTx(tx as never,19);
  await expect(configureOfMaterial(19,'new-source',{expectedVersion:current.version,idempotencyKey:'key',configuration:{operationId:'cut',requirements,supplyMode:'PURCHASE',debitRule:{...rule,unitsPerBlank:2},allowPartial:true,supplierId:'supplier',destinationId:null}},{user_id:1} as never)).rejects.toMatchObject({code:'MATERIAL_DEBIT_DEFINITION_FROZEN'});
  expect(tx.query.mock.calls.some(c=>c[0].startsWith('INSERT INTO public.of_material_needs'))).toBe(false);
  expect(tx.query).toHaveBeenCalledWith('ROLLBACK');
});
it('archives the covered configuration before creating a changed partial-lot policy',async()=>{
  const current=await readMaterialTx(tx as never,19);
  await configureOfMaterial(19,'new-source',{expectedVersion:current.version,idempotencyKey:'key',configuration:{operationId:'cut',requirements,supplyMode:'PURCHASE',debitRule:rule,allowPartial:false,supplierId:'supplier',destinationId:null}},{user_id:1} as never);
  const supersede=tx.query.mock.calls.findIndex(c=>c[0].startsWith('UPDATE public.of_material_needs SET superseded_at'));
  const insert=tx.query.mock.calls.findIndex(c=>c[0].startsWith('INSERT INTO public.of_material_needs'));
  expect(supersede).toBeGreaterThan(-1);expect(insert).toBeGreaterThan(supersede);
  expect(tx.query.mock.calls[supersede][1]).toEqual(['current',1]);
});
it('does not create another historical need for an unchanged JSONB configuration',async()=>{
  const current=await readMaterialTx(tx as never,19);
  await configureOfMaterial(19,'new-source',{expectedVersion:current.version,idempotencyKey:'key',configuration:{operationId:'cut',requirements:Object.fromEntries(Object.entries(requirements).reverse()) as typeof requirements,supplyMode:'PURCHASE',debitRule:rule,allowPartial:true,supplierId:'supplier',destinationId:null}},{user_id:1} as never);
  expect(tx.query.mock.calls.some(c=>c[0].startsWith('UPDATE public.of_material_needs SET superseded_at'))).toBe(false);
});
