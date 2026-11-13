import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({predecessors:vi.fn()}));
vi.mock('../../commande-fournisseur/repository/subcontract-purchase.repository',()=>({readSubcontractForecastPredecessorsTx:m.predecessors}));
import {readProcurementWarningsTx} from './planning-procurement-readiness';
let orders:Array<Record<string,unknown>>,needs:Array<Record<string,unknown>>;
const service={id:'service',type_achat:'TRAITEMENT',article_id:'ps',designation:'Anodisation',gamme_operation_id:'source-op'};
const material={id:'material',type_achat:'MATIERE',article_id:'mp',designation:'Aluminium'};
const tx={query:vi.fn(async(sql:string)=>({rows:sql.includes('FROM public.commande_fournisseur_ligne l')?orders:sql.includes('FROM public.of_material_needs n')?needs:[{id:'op'}]}))};
beforeEach(()=>{orders=[];needs=[];m.predecessors.mockResolvedValue([{status:'TODO',good:0,processed:0}]);});
describe('current procurement warnings',()=>{
 it('reports the material definition and missing draft without blocking the preparation',async()=>{
  const result=await readProcurementWarningsTx(tx as never,3,'v',50,[material]);
  expect(result.get('material')).toEqual(['Aluminium : confirmer les exigences et l’opération consommatrice.','Aluminium : choisir le fournisseur et préparer le brouillon pour le manque.']);
 });
 it('removes purchase warnings after the physical requirement has been covered',async()=>{
  needs=[{source:'material',reviewed:true,mode:'PURCHASE',required:5550,physical:5550}];
  expect((await readProcurementWarningsTx(tx as never,3,'v',50,[material])).get('material')).toEqual([]);
 });
 it('asks for the actual output and origins while a treatment purchase is provisional',async()=>{
  orders=[{source:'service',code:'BCF-TEST',status:'BROUILLON',quantity:50,forecast:true,promise:null,operation:'op'}];
  expect((await readProcurementWarningsTx(tx as never,3,'v',50,[service])).get('service')).toEqual(['Anodisation : confirmer la quantité et les origines après le contrôle de sortie d’usinage.','Anodisation : BCF-TEST en brouillon, à compléter par l’acheteur.']);
 });
 it('clears obsolete draft warnings once all47 conforming pieces are ordered and acknowledged',async()=>{
  m.predecessors.mockResolvedValue([{status:'DONE',good:47,processed:47}]);
  orders=[{source:'service',code:'BCF-FINAL',status:'ACCUSE_RECU',quantity:47,forecast:false,promise:'2026-11-18',operation:'op'}];
  expect((await readProcurementWarningsTx(tx as never,3,'v',50,[service])).get('service')).toEqual([]);
 });
 it('still reports the supplement after a partial order',async()=>{
  m.predecessors.mockResolvedValue([{status:'DONE',good:47,processed:47}]);
  orders=[{source:'service',code:'BCF-FINAL',status:'ACCUSE_RECU',quantity:20,forecast:false,promise:'2026-11-18',operation:'op'}];
  expect((await readProcurementWarningsTx(tx as never,3,'v',50,[service])).get('service')).toEqual(['Anodisation : préparer le complément fournisseur.']);
 });
});
