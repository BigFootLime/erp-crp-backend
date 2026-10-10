import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), client: vi.fn(), contract: vi.fn(), lockArticles: vi.fn(),
  coverage: vi.fn(), intents:vi.fn(), plan: vi.fn(), replay: vi.fn(), insert: vi.fn(), event: vi.fn(), audit: vi.fn(), outbox: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../config/database', () => ({ default: { connect: mocks.connect } }));
vi.mock('../../../shared/realtime/realtime-outbox-transaction', () => ({ withRealtimeOutboxTransaction: mocks.transaction }));
vi.mock('../../../shared/realtime/realtime-outbox.service', () => ({ enqueueEntityChanged: mocks.outbox }));
vi.mock('../../audit-logs/repository/audit-logs.repository', () => ({ repoInsertAuditLog: mocks.audit }));
vi.mock('../repository/client-crm.repository', () => ({ readCrmClient: mocks.client }));
vi.mock('../repository/client-contract.repository', () => ({ readClientContract: mocks.contract, lockContractArticles: mocks.lockArticles }));
vi.mock('./client-contract-coverage.service', () => ({ readClientContractCoverageTx: mocks.coverage }));
vi.mock('../repository/client-contract-replenishment-intents.repository',()=>({readReplenishmentProducerIntents:mocks.intents}));
vi.mock('../repository/client-contract-replenishment.repository', () => ({ readReplenishmentPlan: mocks.plan,
  readReplenishmentReplay: mocks.replay, insertReplenishmentPlan: mocks.insert, appendReplenishmentEvent: mocks.event }));

import { prepareClientReplenishment } from './client-contract-replenishment.service';
import { prepareContractReplenishmentWithIntents } from '../domain/client-contract-replenishment-intent-preparation';
import { HttpError } from '../../../utils/httpError';
import type { AuditContext } from '../repository/client.repository';
import type { ClientReplenishmentPreparationCommand } from '../validators/client-contract-replenishment.validators';
import type { ContractCoverageResult } from '../types/client-contract-coverage.types';

const report: ContractCoverageResult = { contract_id: 'contract-a', contract_version: 1, generated_at: '2026-10-10T08:00:00Z',
  planning_revision: null, start_month: '2026-10', months: 3, readonly: true, snapshot_hash: 'a'.repeat(64),
  lines: [], demands: [], sources: [], allocations: [], issues: [] };
const command: ClientReplenishmentPreparationCommand = { action: 'PREPARE', expected_contract_version: 1,
  expected_plan_id: null, expected_snapshot_hash: report.snapshot_hash, start_month: '2026-10', months: 3 };
const audit: AuditContext = { user_id: 1, ip: null, user_agent: null, device_type: null, os: null, browser: null,
  page_key: 'clients.contracts.replenishment', client_session_id: null,
  path: '/clients/client-a/contracts/contract-a/replenishment/commands' };
const fingerprint = prepareContractReplenishmentWithIntents({report,today:'2026-10-10',allDemands:[],allSources:[],allAllocations:[],intents:[]}).fingerprint;
const savedPlan = { id: 'plan-a', contract_id: 'contract-a', fingerprint, proposals: [] };

beforeEach(() => {
  vi.resetAllMocks(); mocks.connect.mockResolvedValue({ query: mocks.query });
  mocks.transaction.mockImplementation(async (tx, callback) => callback(tx));
  mocks.client.mockResolvedValue({ id: 'client-a', status: 'client', archived_at: null, blocked: false });
  mocks.contract.mockResolvedValue({ id: 'contract-a', version: 1, lines: [] });
  mocks.coverage.mockResolvedValue({ report, clock: { today: '2026-10-10' }, contract:{lines:[]},allDemands:[],allSources:[],allAllocations:[] });
  mocks.intents.mockResolvedValue([]);
  mocks.replay.mockResolvedValue(null); mocks.plan.mockResolvedValueOnce(null).mockResolvedValue(savedPlan);
  mocks.audit.mockResolvedValue({ id: 'audit-a' });
});
const execute = (body = command, key = 'key-a') => prepareClientReplenishment('client-a', 'contract-a', body, key, audit);
describe('contract preparation consistency and retries', () => {
  it('rereads canonical coverage in the caller transaction and saves proposal, audit and outbox together', async () => {
    const result = await execute();
    expect(result).toMatchObject({ replayed: false, result: { unchanged: false, plan: savedPlan } });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.coverage.mock.calls[0][0]).toBe(await mocks.connect.mock.results[0].value);
    expect(mocks.intents).toHaveBeenCalledExactlyOnceWith(await mocks.connect.mock.results[0].value,[],[]);
    expect(mocks.query).toHaveBeenCalledWith('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(mocks.insert).toHaveBeenCalledTimes(1); expect(mocks.event).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0][0].body.action).toBe('CLIENT_REPLENISHMENT_PREPARE');
    expect(mocks.outbox).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls.some(([sql]) => /INSERT.*(?:stock|ordres_fabrication)/i.test(sql))).toBe(false);
    const reconcile = mocks.transaction.mock.calls[0][2].reconcileCommit;
    mocks.replay.mockResolvedValue({ request_hash: mocks.event.mock.calls[0][1].hash });
    expect(await reconcile({ query: mocks.query })).toBe('committed');
    mocks.replay.mockResolvedValue(null); expect(await reconcile({ query: mocks.query })).toBe('not_committed');
  });
  it('returns the original idempotent result without rereading coverage or inserting a second preparation', async () => {
    const original = await execute(); const hash = mocks.event.mock.calls[0][1].hash;
    mocks.replay.mockResolvedValue({ request_hash: hash, result_payload: original.result });
    mocks.coverage.mockClear(); mocks.insert.mockClear(); mocks.event.mockClear(); mocks.outbox.mockClear();
    expect(await execute()).toEqual({ result: original.result, replayed: true });
    expect(mocks.coverage).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled(); expect(mocks.outbox).not.toHaveBeenCalled();
    await expect(execute({ ...command, months: 6 })).rejects.toMatchObject({ code: 'CONTRACT_REPLENISHMENT_KEY_CONFLICT' });
  });
  it('keeps stable plan identity for the same fresh snapshot submitted with a new key', async () => {
    mocks.plan.mockReset().mockResolvedValue(savedPlan);
    expect(await execute(command, 'new-key')).toMatchObject({ result: { unchanged: true, plan: savedPlan } });
    expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.event).toHaveBeenCalledTimes(1);
  });
  it('refuses changed stock/planning, contract versions and another concurrently saved plan', async () => {
    await expect(execute({ ...command, expected_snapshot_hash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CONTRACT_REPLENISHMENT_COVERAGE_CHANGED' });
    await expect(execute({ ...command, expected_contract_version: 2 })).rejects.toMatchObject({ code: 'CONTRACT_REPLENISHMENT_CONTRACT_CHANGED' });
    mocks.plan.mockReset().mockResolvedValue({ ...savedPlan, fingerprint: 'older' });
    await expect(execute()).rejects.toMatchObject({ code: 'CONTRACT_REPLENISHMENT_PLAN_CHANGED' });
    expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });
  it('supersedes a named earlier preparation without mutating its evidence', async () => {
    mocks.plan.mockReset().mockResolvedValueOnce({ ...savedPlan, fingerprint: 'older' }).mockResolvedValue(savedPlan);
    await execute({ ...command, expected_plan_id: 'plan-a' });
    expect(mocks.insert.mock.calls[0][1].previousId).toBe('plan-a');
    expect(mocks.event.mock.calls[0][1].previousId).toBe('plan-a');
  });
  it('aborts when the audit is absent and reports concurrent database changes as actionable conflicts', async () => {
    mocks.audit.mockResolvedValue(null); await expect(execute()).rejects.toThrow('CONTRACT_REPLENISHMENT_AUDIT_INSERT_FAILED');
    expect(mocks.outbox).not.toHaveBeenCalled();
    for (const error of [{ code: '40001' }, { code: '40P01' }, { code: '23505', constraint: 'client_replenishment_current_plan_idx' }]) {
      mocks.transaction.mockRejectedValueOnce(error);
      await expect(execute()).rejects.toMatchObject({ status: 409, code: 'CONTRACT_REPLENISHMENT_CONCURRENT_CHANGE' });
    }
  });
  it('does not persist another preparation when the producer reader requires a quality or grouping review',async()=>{
    mocks.intents.mockRejectedValue(new HttpError(409,'CONTRACT_REPLENISHMENT_INTENT_REVIEW_REQUIRED','Vérifiez la réception'));
    await expect(execute()).rejects.toMatchObject({status:409,code:'CONTRACT_REPLENISHMENT_INTENT_REVIEW_REQUIRED'});
    expect(mocks.insert).not.toHaveBeenCalled();expect(mocks.event).not.toHaveBeenCalled();expect(mocks.audit).not.toHaveBeenCalled();expect(mocks.outbox).not.toHaveBeenCalled();
  });
});
