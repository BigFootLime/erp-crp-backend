import crypto from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),connect:vi.fn(),audit:vi.fn(),totals:vi.fn(),event:vi.fn()}));
vi.mock('../config/database',()=>({default:{query:mocks.query,connect:mocks.connect}}));
vi.mock('../shared/realtime/realtime-outbox.service',()=>({enqueueEntityChanged:mocks.event}));
vi.mock('../module/commande-fournisseur/repository/commande-fournisseur.repository',async importOriginal=>{
  const actual=await importOriginal<typeof import('../module/commande-fournisseur/repository/commande-fournisseur.repository')>();
  return {...actual,insertAuditLog:mocks.audit,recomputeTotauxTx:mocks.totals};
});
import {repoCommandSupplierConsultation} from '../module/commande-fournisseur/repository/supplier-consultation.repository';
import type {SupplierConsultationCommand,SupplierOfferResponse} from '../module/commande-fournisseur/validators/supplier-consultation.validators';
import type {ConsultationSnapshot} from '../module/commande-fournisseur/domain/supplier-consultation';

const id='11111111-1111-4111-8111-111111111111';
const snapshot:ConsultationSnapshot={code:'BCF-TEST',currency:'EUR',delivery_address:null,destination_id:null,freight_vat_pct:20,lines:[{id,designation:'Brut',article_id:null,article_code:null,quantity:40,unit:'u',stock_unit:'u',coefficient:1,vat_pct:20,need_date:'2026-09-18',requirements:[],documents:[],operation:'Découpe',of_id:19}]};
const response:SupplierOfferResponse={reference:'REPONSE-TEST',currency:'EUR',valid_until:'2026-09-20',freight_ht:0,payment_terms:'30 jours',notes:'',lines:[{line_id:id,quantity:50,unit:'u',unit_price_ht:2,discount_pct:0,fees_ht:0,delivery_date:'2026-09-17',conformity:'CONFORMING',conformity_notes:'',supplier_reference:'TEST'}]};
const audit={user_id:1,role:'Administrateur',ip:null,user_agent:null,device_type:null,os:null,browser:null,path:null,page_key:null,client_session_id:null};
const body:SupplierConsultationCommand={action:'SELECT',consultation_id:id,offer_id:id,expected_version:1,expected_updated_at:'2026-09-08 10:00:00+00',idempotency_key:'supplier-selection-test',reason:'Délai et conformité confirmés'};
const state={version:1,revision:body.expected_updated_at,status:'OPEN',offerExists:true,lineExists:true,latest:true,prior:null as null|{request_hash:string;result:unknown}};
beforeEach(()=>{
  vi.clearAllMocks();Object.assign(state,{version:1,revision:body.expected_updated_at,status:'OPEN',offerExists:true,lineExists:true,latest:true,prior:null});
  mocks.connect.mockResolvedValue({query:mocks.query,release:mocks.release});
  mocks.query.mockImplementation(async(sql:string)=>{
    if(/AS enabled/.test(sql))return {rows:[{enabled:true}]};
    if(/FROM public.supplier_consultation_commands/.test(sql))return {rows:state.prior?[state.prior]:[]};
    if(/FROM public.commande_fournisseur\s+WHERE id = \$1::uuid\s+FOR UPDATE/.test(sql))return {rows:[{id,statut:'BROUILLON',updated_at_token:state.revision}]};
    if(/SELECT CURRENT_DATE/.test(sql))return {rows:[{today:'2026-09-08'}]};
    if(/FROM public.supplier_consultations WHERE id=/.test(sql))return {rows:[{id,row_version:state.version,status:state.status,source_revision:body.expected_updated_at,snapshot}]};
    if(/adresse_livraison_texte AS delivery_address/.test(sql)){const {lines,...header}=snapshot;return {rows:[header]};}
    if(/a.code AS article_code/.test(sql))return {rows:snapshot.lines};
    if(/FROM public.supplier_consultation_offers o JOIN/.test(sql))return {rows:state.offerExists?[{id,response,supplier_id:id,is_latest:state.latest}]:[]};
    if(/FROM public.fournisseurs WHERE id/.test(sql))return {rows:[{id,nom:'Fournisseur test',actif:true,status:'actif'}]};
    if(/UPDATE public.commande_fournisseur_ligne SET quantite/.test(sql))return {rows:[],rowCount:state.lineExists?1:0};
    if(/SELECT DISTINCT b.of_id/.test(sql))return {rows:[{of_id:19}]};
    return {rows:[],rowCount:1};
  });
});
const sqls=()=>mocks.query.mock.calls.map(c=>String(c[0]));
describe('choix fournisseur transactionnel',()=>{
  it('met à jour le même brouillon sans créer ni annuler aucune affectation',async()=>{
    await expect(repoCommandSupplierConsultation(id,body,audit)).resolves.toMatchObject({action:'SELECT',consultationId:id,offerId:id});
    expect(sqls()).toContain('COMMIT');expect(sqls()).not.toContain('ROLLBACK');
    expect(sqls().some(s=>/INSERT INTO public.commande_fournisseur\b/.test(s))).toBe(false);
    expect(sqls().some(s=>/(INSERT INTO|UPDATE|DELETE FROM) public.(stock_reservations|commande_fournisseur_ligne_besoin)/.test(s))).toBe(false);
    expect(mocks.totals).toHaveBeenCalledOnce();expect(mocks.audit).toHaveBeenCalledOnce();expect(mocks.event).toHaveBeenCalledTimes(2);
  });
  it('refuse une offre étrangère sans modifier les lignes',async()=>{
    state.offerExists=false;
    await expect(repoCommandSupplierConsultation(id,body,audit)).rejects.toMatchObject({code:'SUPPLIER_OFFER_NOT_FOUND'});
    expect(sqls()).toContain('ROLLBACK');expect(sqls().some(s=>s.includes('SET quantite='))).toBe(false);
  });
  it('refuse la concurrence et une consultation obsolète',async()=>{
    state.version=2;
    await expect(repoCommandSupplierConsultation(id,body,audit)).rejects.toMatchObject({code:'CONSULTATION_CHANGED'});
    state.version=1;state.revision='2026-09-08 11:00:00+00';
    await expect(repoCommandSupplierConsultation(id,{...body,expected_updated_at:state.revision},audit)).rejects.toMatchObject({code:'CONSULTATION_OBSOLETE'});
    expect(mocks.totals).not.toHaveBeenCalled();
  });
  it('rejette une ancienne réponse et conserve le brouillon',async()=>{
    state.latest=false;
    await expect(repoCommandSupplierConsultation(id,body,audit)).rejects.toMatchObject({code:'SUPPLIER_OFFER_SUPERSEDED'});
    expect(sqls()).toContain('ROLLBACK');expect(mocks.totals).not.toHaveBeenCalled();
  });
  it('annule la transaction si une ligne a disparu avant application',async()=>{
    state.lineExists=false;
    await expect(repoCommandSupplierConsultation(id,body,audit)).rejects.toMatchObject({code:'CONSULTATION_OBSOLETE'});
    expect(sqls()).toContain('ROLLBACK');expect(sqls()).not.toContain('COMMIT');expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('rejoue un reçu durable avant de relire les versions modifiées',async()=>{
    state.prior={request_hash:crypto.createHash('sha256').update(JSON.stringify({commandeId:id,body})).digest('hex'),result:{consultationId:id,action:'SELECT',offerId:id}};
    state.version=2;state.status='SELECTED';
    await expect(repoCommandSupplierConsultation(id,body,audit)).resolves.toMatchObject({action:'SELECT'});
    expect(sqls().some(s=>s.includes('SET quantite='))).toBe(false);expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('refuse le réemploi d’une clé pour une autre action',async()=>{
    state.prior={request_hash:'other',result:{}};
    await expect(repoCommandSupplierConsultation(id,body,audit)).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
    expect(sqls()).toContain('ROLLBACK');
  });
  it('refuse un rôle de lecture sans accès aux prix avant toute connexion',async()=>{
    await expect(repoCommandSupplierConsultation(id,body,{...audit,role:'Responsable Qualite'})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
