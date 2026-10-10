import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { PreparedContractReplenishmentPlan } from '../types/client-contract-replenishment.types';
import type { ReplenishmentLaunchResult } from './client-contract-replenishment-launch-tx';
import { runWithAccountModuleAccess } from '../../access-control/context/account-module-access.context';

const ports = vi.hoisted(() => ({ engine: vi.fn(), readPlan: vi.fn(), audit: vi.fn(), outbox: vi.fn(), notify: vi.fn() }));
vi.mock('../../production/domain/of-generation', () => ({ createRecursiveOrdresFabrication: ports.engine }));
vi.mock('../repository/client-contract-replenishment.repository', () => ({ readReplenishmentPlan: ports.readPlan }));
vi.mock('../../audit-logs/repository/audit-logs.repository', () => ({ repoInsertAuditLog: ports.audit }));
vi.mock('../../../shared/realtime/realtime-outbox.service', () => ({ enqueueEntityChanged: ports.outbox }));
vi.mock('../../production/repository/production-replenishment-notifications.repository', () => ({ notifyReplenishmentPlanning: ports.notify }));
import { launchPreparedContractReplenishmentTx } from './client-contract-replenishment-launch-tx';

const contractId = '00000000-0000-4000-8000-000000000001';
const planId = '00000000-0000-4000-8000-000000000002';
const proposalId = '00000000-0000-4000-8000-000000000003';
const key = '00000000-0000-4000-8000-000000000004';
const articleId = '00000000-0000-4000-8000-000000000005';
const versionId = '00000000-0000-4000-8000-000000000006';
const hash = 'a'.repeat(64);

function fixture() {
  const plan: PreparedContractReplenishmentPlan = {
    id: planId, contract_id: contractId, contract_version: 7, status: 'CURRENT', purpose: 'PREPARATION_ONLY',
    fingerprint: 'b'.repeat(64), coverage_snapshot_hash: 'c'.repeat(64), start_month: '2026-10', months: 3,
    as_of_date: '2026-10-10', created_at: '2026-10-10T07:00:00Z', created_by: 12, actor_label: 'Planificateur',
    proposals: [{ id: proposalId, plan_id: planId, contract_line_id: 'line-1', month: '2026-10',
      target_date: '2026-09-30', target_overdue: true, lot_quantity: '20', lot_count: '2', proposed_quantity: '40', surplus_quantity: '10',
      article: { article_id: articleId, root_article_id: articleId, code: 'PF-1', designation: 'Axe', indice: 'C',
        piece_technique_id: '00000000-0000-4000-8000-000000000007', piece_technique_version_id: versionId,
        unit_id: '00000000-0000-4000-8000-000000000008', unit: 'U' } }],
  };
  const fresh = { fingerprint: plan.fingerprint, intent_fingerprint: 'd'.repeat(64),
    report: { contract_id: contractId, contract_version: 7, snapshot_hash: plan.coverage_snapshot_hash } };
  const state = { isolation: 'serializable', ownerVersion: 7 as number | null, existing: false,
    replay: null as null | { client_id: string; contract_id: string; request_hash: string; result_payload: ReplenishmentLaunchResult } };
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql === 'SHOW transaction_isolation') return { rows: [{ transaction_isolation: state.isolation }] };
    if (sql.includes('FROM public.client_contract_replenishment_launches')) return { rows: state.replay ? [state.replay] : [] };
    if (sql.includes('SELECT contract.version')) return { rows: state.ownerVersion === null ? [] : [{ version: state.ownerVersion }] };
    if (sql.includes('SELECT proposal_id')) return { rows: state.existing ? [{ proposal_id: proposalId }] : [] };
    if (sql.includes('SELECT numero FROM public.ordres_fabrication')) return { rows: [{ numero: 'OF-2026-1' }] };
    if (sql.startsWith('INSERT INTO public.client_contract_replenishment_') || sql.startsWith('SELECT pg_advisory_xact_lock')
      || sql.includes('WHERE id=$1::uuid AND contract_id=$2::uuid FOR SHARE')) return { rows: [] };
    throw Error('Unexpected transaction query: ' + sql);
  });
  const tx = { query } as unknown as Pick<PoolClient, 'query'>;
  ports.readPlan.mockResolvedValue(plan);
  ports.engine.mockResolvedValue({ root_of_id: 101, batch_id: 'batch-1', ofs: [{ id: 101, parent_of_id: null }, { id: 102, parent_of_id: 101 }],
    source_hash: 'engine-hash', purchase_requirements: [], warnings: [] });
  ports.audit.mockResolvedValue({ id: 'audit-1', created_at: '2026-10-10T07:00:00Z' });
  ports.outbox.mockResolvedValue(undefined);
  ports.notify.mockResolvedValue({ recipients: 1, notifications: 1 });
  const reread = vi.fn(async () => fresh);
  const input = { client_id: '195', contract_id: contractId, plan_id: planId, proposal_ids: [proposalId], key, request_hash: hash,
    audit: { user_id: 12, ip: null, user_agent: null, device_type: null, os: null, browser: null,
      path: '/clients/195', page_key: 'clients', client_session_id: null }, user_role: 'Production',
    rereadSharedPreparation: reread as unknown as Parameters<typeof launchPreparedContractReplenishmentTx>[1]['rereadSharedPreparation'] };
  return { tx, query, calls, input, state, plan, fresh, reread };
}

beforeEach(() => vi.resetAllMocks());

describe('anticipated generation transaction boundary', () => {
  it('uses the canonical engine and server proposal, keeps the overdue target and binds every proof on the caller transaction', async () => {
    const f = fixture();
    const launched = await launchPreparedContractReplenishmentTx(f.tx, f.input);
    expect(f.reread).toHaveBeenCalledWith(f.tx, f.plan);
    expect(ports.engine).toHaveBeenCalledExactlyOnceWith(f.tx, expect.objectContaining({ source_type: 'MANUAL',
      commande_id: null, commande_ligne_id: null, livraison_affaire_id: null, client_id: '195', qty_to_produce: 40,
      root_article_id: articleId, root_pinned_version_id: versionId, force_preparation: true, idempotency_key: proposalId }));
    expect(launched).toEqual({ replayed: false, result: expect.objectContaining({ plan_id: planId,
      roots: [expect.objectContaining({ root_of_id: 101, quantity: '40', target_date: '2026-09-30', target_overdue: true, child_of_ids: [102] })] }) });
    const proofs = f.calls.filter(call => call.sql.startsWith('INSERT'));
    expect(proofs).toHaveLength(2);
    expect(proofs[1].values).toEqual([launched.result.launch_id, planId, contractId, proposalId, 101, articleId,
      f.plan.proposals[0].article.piece_technique_id, versionId, f.plan.proposals[0].article.unit_id, '40', '2026-09-30']);
    expect(ports.audit).toHaveBeenCalledWith(expect.objectContaining({ tx: f.tx, user_id: 12,
      body: expect.objectContaining({ action: 'CLIENT_REPLENISHMENT_GENERATE' }) }));
    expect(ports.outbox).toHaveBeenCalledWith(f.tx, expect.objectContaining({ entityId: '195' }), expect.any(Object));
    expect(f.calls.some(call => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql))).toBe(false);
  });

  it('returns a durable acknowledgement without rereading changed coverage, creating an OF or rewarding the replay', async () => {
    const f = fixture();
    const saved: ReplenishmentLaunchResult = { launch_id: 'saved', contract_id: contractId, plan_id: planId, roots: [] };
    f.state.replay = { client_id: '195', contract_id: contractId, request_hash: hash, result_payload: saved };
    f.state.ownerVersion = null;
    expect(await launchPreparedContractReplenishmentTx(f.tx, f.input)).toEqual({ result: saved, replayed: true });
    expect(f.reread).not.toHaveBeenCalled(); expect(ports.engine).not.toHaveBeenCalled();
    expect(ports.audit).not.toHaveBeenCalled(); expect(ports.outbox).not.toHaveBeenCalled(); expect(ports.notify).not.toHaveBeenCalled();
  });

  it.each(['client_id', 'contract_id', 'request_hash'] as const)('refuses a replay belonging to another %s', async field => {
    const f = fixture();
    f.state.replay = { client_id: '195', contract_id: contractId, request_hash: hash,
      result_payload: { launch_id: 'saved', contract_id: contractId, plan_id: planId, roots: [] } };
    f.state.replay[field] = 'another';
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toMatchObject({ status: 409, code: 'CONTRACT_REPLENISHMENT_KEY_CONFLICT' });
    expect(ports.engine).not.toHaveBeenCalled();
  });

  it('requires OF generation capability before any SQL even for a durable replay', async () => {
    const f = fixture(); f.input.user_role = 'Commercial';
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toMatchObject({ status: 403 });
    expect(f.query).not.toHaveBeenCalled();
  });

  it('does not turn an ordinary clients-module grant into OF generation permission', async () => {
    const f = fixture();
    const attempt = new Promise((resolve,reject) => runWithAccountModuleAccess({ userId:12,moduleKey:'clients',elevated:false },
      () => { void launchPreparedContractReplenishmentTx(f.tx,f.input).then(resolve,reject); }));
    await expect(attempt).rejects.toMatchObject({ status:403 }); expect(f.query).not.toHaveBeenCalled();
  });

  it('uses the existing production-module grant for its authenticated actor', async () => {
    const f = fixture(); f.input.user_role='Commercial';
    const attempt = new Promise((resolve,reject) => runWithAccountModuleAccess({ userId:12,moduleKey:'production',elevated:false },
      () => { void launchPreparedContractReplenishmentTx(f.tx,f.input).then(resolve,reject); }));
    await expect(attempt).resolves.toMatchObject({ replayed:false }); expect(ports.engine).toHaveBeenCalledTimes(1);
  });

  it('rejects a caller identity different from the authenticated production grant', async () => {
    const f = fixture();
    const attempt = new Promise((resolve,reject) => runWithAccountModuleAccess({ userId:13,moduleKey:'production',elevated:false },
      () => { void launchPreparedContractReplenishmentTx(f.tx,f.input).then(resolve,reject); }));
    await expect(attempt).rejects.toMatchObject({ status:403 }); expect(f.query).not.toHaveBeenCalled();
  });

  it('refuses repeatable-read because a competing contract could add another root', async () => {
    const f = fixture(); f.state.isolation = 'repeatable read';
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toThrow('SERIALIZABLE_TRANSACTION_REQUIRED');
    expect(ports.engine).not.toHaveBeenCalled(); expect(f.query).toHaveBeenCalledTimes(1);
  });

  it.each([[], [proposalId, proposalId], Array.from({ length: 101 }, (_, i) => String(i))].map(ids => ({ ids })))('rejects empty, duplicated or excessive selection before SQL ($ids)', async ({ ids }) => {
    const f = fixture(); f.input.proposal_ids = ids;
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toMatchObject({ status: 422 });
    expect(f.query).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'changed-contract', 'superseded', 'unknown-proposal', 'already-launched'])('does not create production after %s', async reason => {
    const f = fixture();
    if (reason === 'inactive') f.state.ownerVersion = null;
    if (reason === 'changed-contract') f.state.ownerVersion = 8;
    if (reason === 'superseded') f.plan.status = 'SUPERSEDED';
    if (reason === 'unknown-proposal') f.input.proposal_ids = ['unknown'];
    if (reason === 'already-launched') f.state.existing = true;
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toMatchObject({ status: 409 });
    expect(ports.engine).not.toHaveBeenCalled(); expect(f.reread).not.toHaveBeenCalled();
  });

  it.each(['fingerprint', 'contract_id', 'contract_version', 'snapshot_hash'])('requires fresh shared %s before an engine invocation', async field => {
    const f = fixture();
    if (field === 'fingerprint') f.fresh.fingerprint = 'changed';
    else if (field === 'contract_id') f.fresh.report.contract_id = 'another';
    else if (field === 'contract_version') f.fresh.report.contract_version = 8;
    else f.fresh.report.snapshot_hash = 'changed';
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toMatchObject({ status: 409, code: 'CONTRACT_REPLENISHMENT_COVERAGE_CHANGED' });
    expect(ports.engine).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.0001', '1e3', '1000000001'])('validates all selected quantities before creating a first OF (%s)', async invalid => {
    const f = fixture();
    const second = structuredClone(f.plan.proposals[0]); second.id = '00000000-0000-4000-8000-000000000009';
    second.proposed_quantity = invalid; f.plan.proposals.push(second); f.input.proposal_ids.push(second.id);
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toMatchObject({ status: 422 });
    expect(ports.engine).not.toHaveBeenCalled();
  });

  it('propagates engine failure to the transaction owner without launch evidence, audit, notification or local commit', async () => {
    const f = fixture(); const failure = Error('BOM invalid'); ports.engine.mockRejectedValue(failure);
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toBe(failure);
    expect(f.calls.filter(call => call.sql.startsWith('INSERT'))).toHaveLength(0);
    expect(ports.audit).not.toHaveBeenCalled(); expect(ports.outbox).not.toHaveBeenCalled();
  });

  it('propagates proof uniqueness conflicts instead of swallowing them or emitting a confirmation', async () => {
    const f = fixture(); const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values = []) => {
      if (sql.startsWith('INSERT INTO public.client_contract_replenishment_roots')) throw Object.assign(Error('Concurrent root'), { code: '23505' });
      return original(sql, values);
    });
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toMatchObject({ code: '23505' });
    expect(ports.audit).not.toHaveBeenCalled(); expect(ports.outbox).not.toHaveBeenCalled();
  });

  it('leaves rollback to the caller if immutable audit insertion fails; no outbox confirmation is emitted', async () => {
    const f = fixture(); ports.audit.mockResolvedValue(false);
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toThrow('AUDIT_INSERT_FAILED');
    expect(ports.outbox).not.toHaveBeenCalled();
    expect(f.calls.some(call => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql))).toBe(false);
  });

  it('also fails the caller transaction if its outbox cannot be written', async () => {
    const f = fixture(); ports.outbox.mockRejectedValue(Error('outbox unavailable'));
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toThrow('outbox unavailable');
    expect(f.calls.some(call => call.sql === 'COMMIT')).toBe(false);
  });

  it('publishes roots and children with their immutable audit identity before the client event and planner handoff', async () => {
    const f = fixture(); await launchPreparedContractReplenishmentTx(f.tx, f.input);
    expect(ports.outbox.mock.calls.map(call => call[1].entityId)).toEqual(['101', '102', '195']);
    expect(ports.outbox).toHaveBeenNthCalledWith(1, f.tx, expect.objectContaining({ module: 'production', action: 'created',
      at: '2026-10-10T07:00:00Z', invalidateKeys: expect.arrayContaining(['production:ofs', 'production:of:101']) }),
      { deduplicationKey: 'production-audit:audit-1:of:101' });
    expect(ports.notify).toHaveBeenCalledExactlyOnceWith(f.tx, expect.objectContaining({ clientId: '195', contractId,
      roots: [expect.objectContaining({ root_of_id: 101, child_of_ids: [102] })] }));
  });

  it('deduplicates children when the canonical generation result contains a repeated child', async () => {
    const f = fixture(); const generated = await ports.engine.getMockImplementation()!();
    generated.ofs.push({ id: 102, parent_of_id: 101 }); ports.engine.mockResolvedValue(generated);
    await launchPreparedContractReplenishmentTx(f.tx, f.input);
    expect(ports.outbox.mock.calls.filter(call => call[1].entityId === '102')).toHaveLength(1);
  });

  it('keeps a failed planner handoff inside the transaction instead of returning a successful launch', async () => {
    const f = fixture(); ports.notify.mockRejectedValue(Error('notification unavailable'));
    await expect(launchPreparedContractReplenishmentTx(f.tx, f.input)).rejects.toThrow('notification unavailable');
    expect(ports.outbox.mock.calls.some(call => call[1].module === 'clients')).toBe(false);
    expect(f.calls.some(call => call.sql === 'COMMIT')).toBe(false);
  });
});
