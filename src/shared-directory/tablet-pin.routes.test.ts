import express from 'express';
import request from 'supertest';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({row:null as any,queries:[] as Array<{sql:string;params:unknown[]}>,mfa:false}));
vi.mock('./session.repository',()=>({
 validateDirectorySession:vi.fn(async()=>({profile_id:'00000000-0000-4000-8000-000000000001',database:'cerp_prod'})),
 createDirectorySession:vi.fn(async()=>({directory_session:'dir_'+'a'.repeat(64),identity:{}})),
 bindChallenge:vi.fn(async()=>undefined),
}));
vi.mock('../module/auth/services/mfa.service',()=>({beginMfaAfterPassword:vi.fn(async()=>state.mfa?{status:'mfa_required',challenge_token:'challenge',challenge_expires_in_seconds:900,methods:['totp','recovery_code']}:null)}));
import {mountDirectoryTabletPins} from './tablet-pin.operations';

function app(){const db:any={query:async(sql:string,params:unknown[]=[])=>(state.queries.push({sql,params}),{rows:sql.includes('SELECT 1 FROM public.cerp_directory_memberships')?[{}]:sql.includes('FROM public.cerp_directory_tablet_devices ORDER')?[]:[]}),connect:async()=>({query:async(sql:string,params:unknown[]=[])=>(state.queries.push({sql,params}),{rows:/FROM public\.cerp_directory_tablet_devices/.test(sql)&&/FOR UPDATE/.test(sql)&&state.row?[state.row]:[]}),release:()=>undefined})};const instance=express();instance.use(express.json());instance.use((req:any,_res,next)=>{req.directoryCaller='cerp_prod';next();});mountDirectoryTabletPins(instance,db,'secret',(work:any)=>(req,res,next)=>void work(req,res).catch(next));instance.use((error:any,_req:any,res:any,_next:any)=>res.status(error?.status??400).json({code:error?.code??'VALIDATION'}));return instance;}
const payload={username:'operator',device_id:'00000000-0000-4000-8000-000000000010',device_secret:'a'.repeat(64),pin:'0123'};
describe('Directory tablet PIN login route',()=>{
 beforeEach(()=>{state.queries=[];state.mfa=false;state.row={profile_id:'00000000-0000-4000-8000-000000000001',failed_attempts:0,revoked_at:null,is_locked:false,device_secret_hash:'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',pin_hash:'$2b$12$T7ww2rQ6MMGrytcu8uAk2.tYxDDpdU6mkPYbGioTWQmzg6tiO04jO',id:7,password:'hash',mfa_required:false,is_superadmin:false,member_superadmin:false,mfa_reenrollment_required:false,role:'Operateur',status:'Active',user_status:'Active',session_epoch:0,mfa_policy:'optional',has_factor:false};});
 it('rejects a request without a device secret before accessing credentials',async()=>{const res=await request(app()).post('/internal/directory/tablet-pin-login').send({input:{device_id:payload.device_id,pin:'0123'},meta:{ip:null,user_agent:null,device_type:null,os:null,browser:null}});expect(res.status).toBe(400);expect(state.queries).toHaveLength(0);});
 it('rejects an incorrect secret without locking the shared device for other operators',async()=>{const res=await request(app()).post('/internal/directory/tablet-pin-login').send({input:{...payload,device_secret:'b'.repeat(64)},meta:{ip:null,user_agent:null,device_type:null,os:null,browser:null}});expect(res.status).toBe(401);expect(res.body.code).toBe('AUTH_INVALID');expect(state.queries.some(q=>q.sql.includes('SET failed_attempts'))).toBe(false);});
 it('rejects a revoked device with the generic authentication response',async()=>{state.row.revoked_at='2026-01-01T00:00:00Z';const res=await request(app()).post('/internal/directory/tablet-pin-login').send({input:payload,meta:{ip:null,user_agent:null,device_type:null,os:null,browser:null}});expect(res.status).toBe(401);expect(res.body.code).toBe('AUTH_INVALID');});
 it('hands an MFA-required account to the normal Directory challenge flow',async()=>{state.row.mfa_required=true;state.mfa=true;const res=await request(app()).post('/internal/directory/tablet-pin-login').send({input:payload,meta:{ip:null,user_agent:null,device_type:null,os:null,browser:null}});expect(res.status).toBe(200);expect(res.body).toMatchObject({status:'mfa_required',challenge_token:'challenge'});});
 it('lists neutral devices without exposing pairing or secret material',async()=>{const res=await request(app()).post('/internal/directory/tablet-pin-admin-list').send({directory_session:'dir_'+'a'.repeat(64),input:{},meta:{ip:null,user_agent:null,device_type:null,os:null,browser:null}});expect(res.status).toBe(200);expect(JSON.stringify(res.body)).not.toContain('secret');});
});
