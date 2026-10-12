import { beforeEach,describe,expect,it,vi } from 'vitest';
import type {PoolClient} from 'pg';
import {readRecoveryConsolidationContextTx} from './recovery-consolidation-context.repository';
const context=()=>({recovery_id:'r',request_id:'req',request_status:'WAITING_PLANNER',request_version:1,recovery_of_id:2,
  quantity:10,donor_allocation_id:12,protected_before:'2026-10-20',initial_before:'2026-10-19',grouping_id:'group',producer_of_id:1,grouping_state:'ACTIVE',enabled:true,
  donor_snapshot:{commande_id:3,commande_ligne_id:4,livraison_affaire_id:5,piece_technique_id:'pt',technical_version_id:'v'}});
const of=(id:number)=>({id,number:`OF-${id}`,clientId:'client',articleId:'article',pieceId:'pt',versionId:'v',technicalHash:'hash',quantity:id===2?10:100,
  status:'BROUILLON',commande_id:3,commande_ligne_id:4,affaire_id:5,root_of_id:id,covered:false,producer:id===1,updated_at:'2026-10-10'});
const source=()=>({id:10,number:'OF-SOURCE',client_id:'client',quantity:100,received:0,before:'2026-10-22',current_before:'2026-10-21',initial_before:'2026-10-18',active:true,requires_promise:true});
const donor=()=>({before:'2026-10-23',commande_id:3,commande_ligne_id:4,affaire_id:5,client_id:'client',article_id:'article',piece_id:'pt',version_id:'v',active:true});
let data:{context:ReturnType<typeof context>;definitions:ReturnType<typeof of>[];sources:ReturnType<typeof source>[];donor:ReturnType<typeof donor>};
let query:ReturnType<typeof vi.fn>;
beforeEach(()=>{data={context:context(),definitions:[of(1),of(2)],sources:[source()],donor:donor()};query=vi.fn()
  .mockImplementationOnce(async()=>({rows:[data.context]})).mockImplementationOnce(async()=>({rows:data.definitions}))
  .mockImplementationOnce(async()=>({rows:data.sources})).mockImplementationOnce(async()=>({rows:[data.donor]}));});
const read=()=>readRecoveryConsolidationContextTx({query} as unknown as Pick<PoolClient,'query'>,'r','group');
describe('recovery grouping identity and promises',()=>{
  it('protects original and current donor AR plus every unfinished source AR',async()=>{
    const result=await read();expect(result.originalIdentityMatches).toBe(true);expect(result.sameClientSources).toBe(true);
    expect(result.deadlines.map(d=>d.before)).toEqual(['2026-10-19','2026-10-20','2026-10-23','2026-10-18']);
  });
  it.each(['commande_id','commande_ligne_id','affaire_id','quantity','root_of_id'] as const)('detects changed recovery %s',async field=>{
    data.definitions[1][field]=999;expect((await read()).originalIdentityMatches).toBe(false);
  });
  it('rejects a cancelled donor and distinct article',async()=>{
    data.donor.active=false;expect((await read()).originalIdentityMatches).toBe(false);
  });
  it('keeps missing active firm promises blocking even with a historical deadline',async()=>{
    data.sources[0].current_before=null as unknown as string;
    expect((await read()).deadlines.at(-1)?.before).toBeNull();
  });
  it('allows an internal source to use its production target',async()=>{
    data.sources[0].current_before=null as unknown as string;data.sources[0].initial_before=null as unknown as string;
    data.sources[0].requires_promise=false;expect((await read()).deadlines.at(-1)?.before).toBe('2026-10-22');
  });
  it('flags cancelled and other-client sources',async()=>{
    data.sources[0].active=false;data.sources[0].client_id='other';const result=await read();
    expect(result.sameClientSources).toBe(false);expect(result.issues[0].code).toBe('GROUPING_SOURCE_CANCELLED');
  });
  it('honors the existing feature flag',async()=>{
    data.context.enabled=false;await expect(read()).rejects.toMatchObject({status:409,code:'CONSOLIDATION_DISABLED'});
    expect(query).toHaveBeenCalledTimes(1);
  });
});
