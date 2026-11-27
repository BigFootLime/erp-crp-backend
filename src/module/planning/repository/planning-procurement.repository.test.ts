import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {AuditContext} from '../../production/repository/production.repository';

const m=vi.hoisted(()=>({read:vi.fn(),service:vi.fn(),drafts:vi.fn()}));
vi.mock('../../production/repository/of-material.repository',()=>({readMaterialTx:m.read}));
vi.mock('../../subcontract/subcontract-procurement.repository',()=>({readSubcontractProcurementTx:m.service}));
vi.mock('../../commande-fournisseur/repository/commande-fournisseur.repository',()=>({createMaterialDraftsTx:m.drafts}));
vi.mock('../../commande-fournisseur/repository/subcontract-purchase.repository',()=>({readSubcontractForecastPredecessorsTx:async()=>[]}));
vi.mock('./planning-procurement-readiness',()=>({readProcurementWarningsTx:async()=>new Map()}));

import {readPlanningProcurementTx,savePlanningProcurementTx} from './planning-procurement.repository';
const ofId=81;
const audit={user_id:3} as AuditContext;
const supplier='00000000-0000-4000-8000-000000000008';
const article='00000000-0000-4000-8000-000000000009';
const operation='00000000-0000-4000-8000-000000000010';
const source='00000000-0000-4000-8000-000000000011';
const offer='00000000-0000-4000-8000-000000000012';
const lot={id:'lot',batchId:'batch'};
const need=()=>({id:'need',articleId:article,key:source,designation:'Matière',reviewed:true,operationId:operation,
  supplierId:supplier,catalog:null,destinationId:null,currency:'EUR',price:null,unit:'u',supplyMode:'PURCHASE',
  debitRule:{form:'UNIT',unitsPerBlank:1,kerfPerBlank:0},reserved:0,consumed:0,required:10,missing:10,purchaseMissing:0,
  expected:0,receivedBlocked:0,blockers:[],futureSupplies:[],candidates:[{lot}],promises:[],
  selections:[{batchId:lot.batchId,lotId:lot.id,quantity:10}],requirements:{grade:null,condition:null,certificates:[],manualChecks:[],dimensions:{}}});

const transaction=(offers:unknown[]=[],prices:unknown[]=[])=>({
  query:vi.fn(async(sql:string)=>{
    if(sql.includes('FROM public.fournisseur_catalogue c'))return {rows:offers};
    if(sql.includes('SELECT DISTINCT ON (l.article_id'))return {rows:prices};
    return {rows:[]};
  }),
});
function material(value:ReturnType<typeof need>,dossierStatus='COMPLETE'){
  m.read.mockImplementation(async()=>({technicalHash:'hash',technicalVersion:'version',previousNeeds:[],number:'OF-TEST',
    version:'material',executionStatus:'BROUILLON',dossierStatus,needs:[value],operations:[{id:operation,label:'Découpe'}],
    suppliers:[{id:supplier,name:'Fournisseur'}]}));
}
beforeEach(()=>{
  vi.resetAllMocks();
  m.service.mockResolvedValue({version:'service',of:{quantity:10,ofRevisionId:null},purchases:[],operations:[],purchasePreparations:[]});
  m.drafts.mockResolvedValue([{id:'draft',code:'BCF-TEST'}]);
});
async function save(tx:ReturnType<typeof transaction>,catalogueId:string|null=null){
  const client=tx as unknown as PoolClient;
  const current=await readPlanningProcurementTx(client,ofId);
  return savePlanningProcurementTx(client,ofId,{expectedVersion:current.version,idempotencyKey:'00000000-0000-4000-8000-000000000014',
    scope:'material',entries:[{key:`MATIERE:${source}`,supplierId:supplier,catalogueId,due:current.entries[0].due}]},audit,true);
}
describe('préparation explicite des achats matière',()=>{
  it('bloque les achats et conserve le stock tant que le dossier n’est pas complet',async()=>{
    material({...need(),purchaseMissing:5},'INCOMPLETE');
    await expect(save(transaction())).rejects.toMatchObject({code:'MATERIAL_DOSSIER_REQUIRED'});
    expect(m.drafts).not.toHaveBeenCalled();
  });

  it('achète seulement le manque dans l’unité fournisseur avec le prix historique',async()=>{
    const value={...need(),unit:'mm',required:5550,missing:5550,purchaseMissing:3550,debitRule:{form:'BAR',unitsPerBlank:100,kerfPerBlank:0},
      selections:[{batchId:lot.batchId,lotId:lot.id,quantity:2000}]};
    material(value);
    const tx=transaction([{id:offer,article_id:article,supplier_id:supplier,label:'Fournisseur',unit:'barre',stock_unit:'mm',coefficient:3000,
      price:43,currency:'EUR',pack:null,moq:null}],
    [{supplierId:supplier,articleId:article,unit:'barre',price:40,currency:'EUR'}]);
    const result=await save(tx,offer);
    expect(m.drafts).toHaveBeenCalledWith(tx,[expect.objectContaining({unit:'barre',stockUnit:'mm',coefficient:3000,
      quantity:2,assigned:3550,price:40,catalogueId:offer})],audit);
    expect(result?.orders).toEqual([{id:'draft',code:'BCF-TEST'}]);
  });

  it('commande 6 040 mm pour un manque de 4 000 mm débité sur des barres source de 3 020 mm', async () => {
    const value = { ...need(), unit: 'mm', required: 4000, missing: 4000, purchaseMissing: 4000,
      sourceBarLengthMm: 3020, selections: [], debitRule: { form: 'BAR', unitsPerBlank: 100, kerfPerBlank: 0 } };
    material(value);
    const tx = transaction();
    await save(tx);
    expect(m.drafts).toHaveBeenCalledWith(tx, [expect.objectContaining({ unit: 'mm', quantity: 6040, assigned: 4000 })], audit);
  });
});
