import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {AuditContext} from '../../production/repository/production.repository';

const m=vi.hoisted(()=>({read:vi.fn(),service:vi.fn(),reserve:vi.fn(),consume:vi.fn(),drafts:vi.fn(),audit:vi.fn()}));
vi.mock('../../production/repository/of-dossier.repository',()=>({materialWorkflowEnabled:async()=>true}));
vi.mock('../../production/repository/of-material.repository',()=>({readMaterialTx:m.read}));
vi.mock('../../production/repository/of-material-confirmation.repository',()=>({reserveMaterialSelectionTx:m.reserve}));
vi.mock('../../stock/repository/partial-reservation-consumption.repository',()=>({consumeMaterialReservationTx:m.consume}));
vi.mock('../../subcontract/subcontract-procurement.repository',()=>({readSubcontractProcurementTx:m.service}));
vi.mock('../../commande-fournisseur/repository/commande-fournisseur.repository',()=>({createMaterialDraftsTx:m.drafts}));
vi.mock('../../commande-fournisseur/repository/subcontract-purchase.repository',()=>({readSubcontractForecastPredecessorsTx:async()=>[]}));
vi.mock('../../production/repository/production-preparation.repository',()=>({preparationAudit:m.audit}));
vi.mock('./planning-procurement-readiness',()=>({readProcurementWarningsTx:async()=>new Map()}));

import {prepareAutomaticPlanningPurchasesTx} from './planning-procurement.repository';
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
function material(value:ReturnType<typeof need>){
  m.read.mockImplementation(async()=>({technicalHash:'hash',technicalVersion:'version',previousNeeds:[],number:'OF-TEST',
    version:'material',executionStatus:'BROUILLON',needs:[value],operations:[{id:operation,label:'Découpe'}],
    suppliers:[{id:supplier,name:'Fournisseur'}]}));
}
beforeEach(()=>{
  vi.resetAllMocks();
  m.service.mockResolvedValue({version:'service',of:{quantity:10,ofRevisionId:null},purchases:[],operations:[],purchasePreparations:[]});
  m.drafts.mockResolvedValue([{id:'draft',code:'BCF-TEST'}]);
  m.reserve.mockResolvedValue({reservation:{id:'reservation',row_version:1}});
});
describe('stock et achats lors de la validation OF',()=>{
  it('sort les bruts unitaires réservés et ne crée pas de brouillon si le stock couvre le besoin',async()=>{
    const value=need();material(value);
    m.consume.mockImplementation(async()=>{value.selections=[];value.consumed=10;value.missing=0;});
    const tx=transaction();
    await prepareAutomaticPlanningPurchasesTx(tx as unknown as PoolClient,ofId,audit,true,{reserve:true,deplete:true,reviewedSources:new Set()});
    expect(m.reserve).toHaveBeenCalledWith(tx,ofId,'OF-TEST',value,lot,10,expect.any(String),audit);
    expect(m.consume).toHaveBeenCalledWith(tx,expect.objectContaining({operationId:operation,reservationId:'reservation',quantity:10,expectedVersion:1}),audit);
    expect(m.drafts).not.toHaveBeenCalled();
  });

  it('réserve les barres compatibles sans les sortir et achète le manque dans l’unité fournisseur avec le prix historique',async()=>{
    const value={...need(),unit:'mm',required:5550,missing:5550,purchaseMissing:3550,debitRule:{form:'BAR',unitsPerBlank:100,kerfPerBlank:0},
      selections:[{batchId:lot.batchId,lotId:lot.id,quantity:2000}]};
    material(value);
    m.reserve.mockImplementation(async()=>{value.reserved=2000;value.missing=3550;value.selections=[];return {reservation:{id:'reservation',row_version:1}};});
    const tx=transaction([{id:offer,article_id:article,supplier_id:supplier,label:'Fournisseur',unit:'barre',stock_unit:'mm',coefficient:3000,
      price:43,currency:'EUR',pack:null,moq:null}],
    [{supplierId:supplier,articleId:article,unit:'barre',price:40,currency:'EUR'}]);
    const result=await prepareAutomaticPlanningPurchasesTx(tx as unknown as PoolClient,ofId,audit,true,{reserve:true,deplete:true,reviewedSources:new Set()});
    expect(m.reserve).toHaveBeenCalledTimes(1);
    expect(m.consume).not.toHaveBeenCalled();
    expect(m.drafts).toHaveBeenCalledWith(tx,[expect.objectContaining({unit:'barre',stockUnit:'mm',coefficient:3000,
      quantity:2,assigned:3550,price:40,catalogueId:offer})],audit);
    expect(result?.orders).toEqual([{id:'draft',code:'BCF-TEST'}]);
  });
});
