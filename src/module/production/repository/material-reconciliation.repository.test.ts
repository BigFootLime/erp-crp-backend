import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),command:vi.fn(),dossier:vi.fn()}));
vi.mock('./of-material.repository',()=>({materialCommand:m.command,readMaterialTx:m.read}));
vi.mock('./of-dossier.repository',()=>({readOfDossierTx:m.dossier}));
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {reconcileMaterialRevision} from './material-reconciliation.repository';
const tx={query:vi.fn(),release:vi.fn()},audit={user_id:1} as never;
const body={previousNeedId:'old',targetNeedId:'current',disposition:'CARRY' as const,reason:'Révision compatible, engagement conservé',expectedVersion:'v',idempotencyKey:'key'};
let previous:{id:string;designation:string;reservations:{id:string}[];promises:{command_id:string}[];customerCalls:{id:string}[];targets:{id:string;designation:string;required:number;blockers:string[]}[]};
beforeEach(()=>{vi.resetAllMocks();previous={id:'old',designation:'Matière ancienne',reservations:[{id:'res'}],promises:[{command_id:'purchase'}],customerCalls:[],targets:[{id:'current',designation:'Matière courante',required:100,blockers:[]}]};
  tx.query.mockResolvedValue({rows:[]});m.dossier.mockResolvedValue({executionStatus:'PLANIFIE'});m.read.mockResolvedValue({previousNeeds:[]});
  m.command.mockImplementation((_of,_type,_body,_audit,fn)=>withRealtimeOutboxTransaction(tx as never,client=>fn(client,{previousNeeds:[previous],technicalVersion:'new',technicalHash:'hash'})));
});
it('adds a resolution with the reviewed commitments and leaves all stock and purchase entries untouched',async()=>{
  await reconcileMaterialRevision(19,body,audit);
  const insert=tx.query.mock.calls.find(c=>c[0].startsWith('INSERT INTO public.of_material_revision_resolutions'));
  expect(insert?.[1].slice(0,5)).toEqual([19,'old','current','CARRY',body.reason]);
  expect(JSON.parse(insert?.[1][5]).previous).toMatchObject({reservationIds:['res'],purchaseIds:['purchase']});
  expect(tx.query.mock.calls.filter(c=>/^(INSERT|UPDATE|DELETE)/.test(c[0])).map(c=>c[0].split(/\s+/).slice(0,3).join(' '))).toEqual(['INSERT INTO public.of_material_revision_resolutions(of_id,previous_need_id,target_need_id,disposition,reason,reviewed_snapshot,command_key,created_by)','UPDATE public.of_dossier_validations SET']);
  expect(tx.query).toHaveBeenCalledWith('COMMIT');
});
it('refuses incompatible or already resolved needs before writing',async()=>{
  previous.targets[0].blockers=['Autre client propriétaire'];await expect(reconcileMaterialRevision(19,body,audit)).rejects.toMatchObject({code:'MATERIAL_REVISION_INCOMPATIBLE'});
  await expect(reconcileMaterialRevision(19,{...body,previousNeedId:'unknown'},audit)).rejects.toMatchObject({code:'MATERIAL_REVISION_ALREADY_REVIEWED'});
  expect(tx.query.mock.calls.some(c=>c[0].startsWith('INSERT'))).toBe(false);
});
it('keeps incompatible commitments separate only through an explicit recorded decision',async()=>{
  await reconcileMaterialRevision(19,{...body,targetNeedId:null,disposition:'KEEP_SEPARATE'},audit);
  const insert=tx.query.mock.calls.find(c=>c[0].startsWith('INSERT'));expect(insert?.[1][2]).toBeNull();expect(insert?.[1][3]).toBe('KEEP_SEPARATE');
});
it('rolls back a failed resolution and keeps closed OFs read-only',async()=>{
  tx.query.mockImplementation(async(sql:string)=>{if(sql.startsWith('INSERT'))throw new Error('history unavailable');return {rows:[]}});
  await expect(reconcileMaterialRevision(19,body,audit)).rejects.toThrow('history unavailable');expect(tx.query).toHaveBeenCalledWith('ROLLBACK');
  m.dossier.mockResolvedValue({executionStatus:'TERMINE'});await expect(reconcileMaterialRevision(19,body,audit)).rejects.toMatchObject({code:'MATERIAL_OF_CLOSED'});
});
