import {describe,it,expect,vi} from 'vitest';
import type {CentralTask,Resource} from '../types/planning-central.types';
import type {ExternalServicePreparation,SubcontractFlow} from '../../subcontract/subcontract-flow.types';
const mocks=vi.hoisted(()=>({flows:vi.fn(),transfers:vi.fn(),preparations:vi.fn(),progress:vi.fn()}));
vi.mock('../../subcontract/subcontract-flow.repository',()=>({subcontractFlowInstalled:async()=>true,readSubcontractFlows:mocks.flows,readExternalTransfers:mocks.transfers}));
vi.mock('../../subcontract/subcontract-planning-preparation.repository',()=>({readExternalPreparationsTx:mocks.preparations}));
vi.mock('../../commande-fournisseur/repository/subcontract-purchase.repository',()=>({readSubcontractForecastPredecessorsTx:mocks.progress}));
import {hydrateExternalPlanning} from './planning-external.repository';

describe('traitement après rebuts #1836',()=>{
 it('rend la population réellement retournée disponible sans réécrire la prévision d’achat initiale',async()=>{
  const returned='2026-11-18T10:00:00.000Z';
  const task={id:'op:service',operationId:'service',view:'external',quantity:50,committed:null,commitment:'DONE',version:'1',blockers:[]} as unknown as CentralTask;
  const saved={id:'preparation',purchaseId:'purchase',operationId:'service',quantity:50,supplierId:'supplier',supplierName:'Fournisseur',orderLineIds:['line'],due:null,leadDays:7,version:'1'} as ExternalServicePreparation;
  const flow={packageId:'package',operationId:'service',supplierId:'supplier',supplierName:'Fournisseur',orderLineId:'line',planned:47,issued:47,returned:47,released:47,departedAt:'2026-11-16T08:00:00Z',lastReturnAt:returned,returns:[]} as unknown as SubcontractFlow;
  mocks.flows.mockResolvedValue([flow]);mocks.transfers.mockResolvedValue([{operation_id:'service',effective:47,created_at:returned}]);
  mocks.preparations.mockResolvedValue(new Map([['service',{preparations:[saved],issues:[]}]]));
  mocks.progress.mockResolvedValue([{status:'DONE',good:47,processed:50,direct:true}]);
  const tx={query:vi.fn(async()=>({rows:[{supplier_id:'supplier',name:'Fournisseur',closed_dates:[],working_days:[]}]}))};
  await hydrateExternalPlanning(tx as never,[task],[] as Resource[],[],'2026-11-16T00:00:00Z','2026-12-31T00:00:00Z');
  expect(task).toMatchObject({quantity:47,good:47,released:47,external:{fullReadyAt:returned,issues:[],preparations:[{quantity:47}]}});
  expect(saved.quantity).toBe(50);
 });
});
