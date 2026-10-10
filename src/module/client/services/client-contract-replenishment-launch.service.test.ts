import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({connect:vi.fn(),query:vi.fn(),transaction:vi.fn(),launch:vi.fn(),replay:vi.fn(),
  lockArticles:vi.fn(),coverage:vi.fn(),intents:vi.fn(),preparation:vi.fn()}));
vi.mock('../../../config/database',()=>({default:{connect:mocks.connect}}));
vi.mock('../../../shared/realtime/realtime-outbox-transaction',()=>({withRealtimeOutboxTransaction:mocks.transaction}));
vi.mock('../repository/client-contract.repository',()=>({lockContractArticles:mocks.lockArticles}));
vi.mock('../repository/client-contract-replenishment-launch.repository',()=>({readReplenishmentLaunchReplay:mocks.replay}));
vi.mock('../repository/client-contract-replenishment-intents.repository',()=>({readReplenishmentProducerIntents:mocks.intents}));
vi.mock('../domain/client-contract-replenishment-intent-preparation',()=>({prepareContractReplenishmentWithIntents:mocks.preparation}));
vi.mock('./client-contract-coverage.service',()=>({readClientContractCoverageTx:mocks.coverage}));
vi.mock('./client-contract-replenishment-launch-tx',()=>({launchPreparedContractReplenishmentTx:mocks.launch}));

import { generateClientContractReplenishment } from './client-contract-replenishment-launch.service';
import type { AuditContext } from '../repository/client.repository';
import type { ClientReplenishmentLaunchCommand } from '../validators/client-contract-replenishment.validators';

const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const contract='abcdefab-3333-4333-8333-333333333333',planId='44444444-4444-4444-8444-444444444444';
const key='55555555-5555-4555-8555-555555555555',client='195';
const audit:AuditContext={user_id:7,ip:null,user_agent:null,device_type:null,os:null,browser:null,
  page_key:'production.replenishment',client_session_id:null,path:'/production/replenishment/commands'};
const command:ClientReplenishmentLaunchCommand={action:'GENERATE',plan_id:planId,proposal_ids:[b,a]};
const tx={query:mocks.query},result={result:{launch_id:'launch-a'},replayed:false};
beforeEach(()=>{
  vi.resetAllMocks();mocks.connect.mockResolvedValue(tx);mocks.query.mockResolvedValue({rows:[{installed:true}]});
  mocks.transaction.mockImplementation(async (connection,work)=>work(connection));mocks.launch.mockResolvedValue(result);
  mocks.replay.mockResolvedValue(null);
  mocks.coverage.mockResolvedValue({report:{contract_id:contract},clock:{today:'2026-10-10'},contract:{lines:[{proposed_article:{article_id:a}}]},
    allDemands:['firm'],allSources:['stock'],allAllocations:['reserved']});
  mocks.intents.mockResolvedValue(['draft-intent']);mocks.preparation.mockReturnValue({fingerprint:'fresh'});
});
const execute=(body=command,requestKey=key)=>generateClientContractReplenishment(client,contract,body,requestKey,audit,'Planificateur');

describe('unrouted replenishment generation transaction boundary',()=>{
  it('owns serializable commit and rereads the canonical budget on the exact caller connection',async()=>{
    expect(await execute()).toEqual(result);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    const input=mocks.launch.mock.calls[0][1];
    expect(input).toMatchObject({client_id:client,contract_id:contract,plan_id:planId,proposal_ids:[a,b],key,audit,user_role:'Planificateur'});
    const plan={start_month:'2026-10',months:3,proposals:[{article:{article_id:a}},{article:{article_id:a}}]};
    expect(await input.rereadSharedPreparation(tx,plan)).toEqual({fingerprint:'fresh'});
    expect(mocks.lockArticles).toHaveBeenCalledExactlyOnceWith(tx,[a]);
    expect(mocks.coverage).toHaveBeenCalledExactlyOnceWith(tx,client,contract,{start_month:'2026-10',months:3});
    expect(mocks.intents).toHaveBeenCalledExactlyOnceWith(tx,[a],['stock']);
    expect(mocks.preparation).toHaveBeenCalledWith({report:{contract_id:contract},today:'2026-10-10',allDemands:['firm'],allSources:['stock'],allAllocations:['reserved'],intents:['draft-intent']});
    expect(mocks.query.mock.calls.some(([sql])=>/INSERT.*(?:stock|ordres_fabrication)/i.test(sql))).toBe(false);
  });
  it('canonicalizes the same selection order while distinguishing a different plan',async()=>{
    await execute();const first=mocks.launch.mock.calls[0][1].request_hash;
    await execute({...command,proposal_ids:[a,b]});expect(mocks.launch.mock.calls[1][1].request_hash).toBe(first);
    await execute({...command,plan_id:a});expect(mocks.launch.mock.calls[2][1].request_hash).not.toBe(first);
    await generateClientContractReplenishment(client,contract.toUpperCase(),command,key,audit,'Planificateur');
    expect(mocks.launch.mock.calls[3][1].request_hash).toBe(first);
  });
  it('reconciles only the matching immutable acknowledgement, actor, owner and launch',async()=>{
    await execute();const hash=mocks.launch.mock.calls[0][1].request_hash,verifier={query:vi.fn()};
    const reconcile=mocks.transaction.mock.calls[0][2].reconcileCommit;
    expect(await reconcile(verifier,result)).toBe('not_committed');
    const saved={client_id:client,contract_id:contract,request_hash:hash,result_payload:{launch_id:'launch-a'}};
    mocks.replay.mockResolvedValue(saved);expect(await reconcile(verifier,result)).toBe('committed');
    expect(mocks.replay).toHaveBeenCalledWith(verifier,audit.user_id,key);
    for(const altered of [{client_id:'196'},{contract_id:a},{request_hash:'other'},{result_payload:{launch_id:'another-launch'}}]) {
      mocks.replay.mockResolvedValue({...saved,...altered});expect(await reconcile(verifier,result)).toBe('unknown');
    }
  });
  it('returns a durable replay without invoking the fresh reader or opening another pool',async()=>{
    mocks.launch.mockResolvedValue({...result,replayed:true});
    expect(await execute()).toEqual({...result,replayed:true});
    expect(mocks.coverage).not.toHaveBeenCalled();expect(mocks.intents).not.toHaveBeenCalled();expect(mocks.connect).toHaveBeenCalledTimes(1);
  });
  it('refuses absent schema with an actionable conflict before querying producer tables',async()=>{
    mocks.query.mockResolvedValue({rows:[{installed:false}]});
    await expect(execute()).rejects.toMatchObject({status:409,code:'CONTRACT_REPLENISHMENT_NOT_INSTALLED'});
    expect(mocks.launch).not.toHaveBeenCalled();expect(mocks.coverage).not.toHaveBeenCalled();
  });
  it('rejects malformed or duplicated selection before connecting',async()=>{
    for(const invalid of [{...command,proposal_ids:[]},{...command,proposal_ids:[a,a]},{...command,proposal_ids:['bad']},
      {...command,proposal_ids:[a,a.toUpperCase()]},{...command,proposal_ids:Array.from({length:101},()=>a)},
      {...command,plan_id:'bad'},{...command,quantity:200}])
      await expect(execute(invalid as ClientReplenishmentLaunchCommand)).rejects.toMatchObject({status:422,code:'CONTRACT_REPLENISHMENT_SELECTION_INVALID'});
    await expect(execute(command,'not-a-key')).rejects.toMatchObject({status:422});
    await expect(generateClientContractReplenishment(client,'bad-contract',command,key,audit,'Planificateur')).rejects.toMatchObject({status:422});
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([{code:'40001'},{code:'40P01'},{code:'23505',constraint:'client_contract_replenishment_roots_proposal_id_key'},
    {code:'23505',constraint:'client_contract_replenishment_roots_root_of_id_key'},
    {code:'23505',constraint:'client_replenishment_roots_proposal_lot_key'}])('converts concurrent writer errors to a refreshable conflict: %j',async error=>{
      mocks.transaction.mockRejectedValue(error);await expect(execute()).rejects.toMatchObject({status:409,code:'CONTRACT_REPLENISHMENT_CONCURRENT_CHANGE'});
  });
  it('preserves uncertain commits and unrelated database/engine errors',async()=>{
    for(const error of [{status:503,code:'REALTIME_COMMIT_OUTCOME_UNKNOWN'},{code:'23505',constraint:'unrelated_unique'},{code:'ENGINE_FAILURE'}]) {
      mocks.transaction.mockRejectedValue(error);await expect(execute()).rejects.toBe(error);
    }
  });
});
