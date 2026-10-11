import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), snapshot: vi.fn(), dependencies: vi.fn(), coverage: vi.fn(),
  dossier: vi.fn(), donors: vi.fn(), audit: vi.fn(), ofAudit: vi.fn(), enqueue: vi.fn() }));
vi.mock('../../../config/database', () => ({ default: { connect: vi.fn(async () => ({ query: mocks.query, release: mocks.release })) } }));
vi.mock('./planning-central.repository', () => ({ readCentralSnapshot: mocks.snapshot, readCentralDependencies: mocks.dependencies }));
vi.mock('./planning-coverage.repository', () => ({ readPlanningCoverageTx: mocks.coverage }));
vi.mock('../../production/repository/of-dossier.repository', () => ({ readOfDossierTx: mocks.dossier }));
vi.mock('../../production/repository/of-component-coverage.repository', () => ({ readOfComponentCoverageTx: vi.fn() }));
vi.mock('../../livraisons/repository/delivery-urgency.repository', () => ({ readDeliveryUrgencyPlan: mocks.donors }));
vi.mock('../../production/repository/production-preparation.repository', () => ({ preparationAudit: mocks.ofAudit }));
vi.mock('../../audit-logs/repository/audit-logs.repository', () => ({ repoInsertAuditLog: mocks.audit }));
vi.mock('../../../shared/realtime/realtime-outbox.service', () => ({ enqueueEntityChanged: mocks.enqueue }));
import { previewUrgencyApproval, approveUrgencyRecovery } from './urgency-approval.repository';
import type { AuditContext } from '../../production/repository/production.repository';

const id = '27c49f48-1c5f-4c33-a748-49c1b3e3fa2c';
const at = (hour: number) => `2026-10-12T${String(hour).padStart(2,'0')}:00:00.000Z`;
const audit: AuditContext = { user_id: 8, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };
let version: number, status: string, approval: { id: string; request_hash: string; response: unknown } | undefined;
function defaultQuery(sql: string, values: unknown[] = []) {
  if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql) || sql.includes('pg_advisory') || sql.includes('planning_central_settings')) return { rows: [] };
  if (sql.includes('SELECT id FROM public.delivery_urgency_requests')) return { rows: [{ id }] };
  if (sql.includes('FROM public.delivery_urgency_approvals')) return { rows: approval ? [approval] : [] };
  if (sql.includes('FROM public.delivery_urgency_requests')) return { rows: [{ id, beneficiary_allocation_id: 1, quantity: '10', version, status, approved_id: approval?.id ?? null }] };
  if (sql.includes('FROM public.delivery_urgency_recoveries recovery JOIN public.ordres_fabrication')) return { rows: [{ id: 'recovery1', donor_allocation_id: 2, recovery_of_id: 101,
    quantity: '10', protected_due_date: '2026-10-14', protected_before: '2026-10-13T22:00:00.000Z', initial_ar_due_date: '2026-10-14',
    donor_snapshot: { commande_id: 20, commande_ligne_id: 21, livraison_affaire_id: 22, piece_technique_id: 'piece1', technical_version_id: 'version1' },
    commande_id: 20, commande_ligne_id: 21, affaire_id: 22, client_id: '195', article_id: 'article1', piece_technique_id: 'piece1', technical_version_id: 'version1', root_of_id: 101, of_quantity: '10' }] };
  if (sql.includes('FROM public.delivery_urgency_sources')) return { rows: [{ recovery_id: 'recovery1', donor_reservation_id: 'reservation1', quantity: '10' }] };
  if (sql.includes('FROM public.ordres_fabrication')) return { rows: [{ id: 101, root_of_id: 101, quantity: 10 }] };
  if (sql.includes('AS boundary')) return { rows: [{ boundary: '2026-10-13T22:00:00.000Z' }] };
  if (sql.includes('INSERT INTO public.delivery_urgency_approvals')) {
    approval = { id: String(values[0]), request_hash: String(values[8]), response: JSON.parse(String(values[6])) }; return { rows: [] };
  }
  if (sql.includes('UPDATE public.delivery_urgency_requests')) { version++; status = 'APPROVED'; return { rows: [] }; }
  throw new Error(`Unexpected SQL: ${sql}`);
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date(at(6)));
  version = 1; status = 'WAITING_PLANNER'; approval = undefined; mocks.query.mockImplementation(defaultQuery);
  mocks.dependencies.mockResolvedValue([]); mocks.coverage.mockResolvedValue({ sources: [], demands: [], allocations: [], coverageAvailable: true });
  mocks.dossier.mockResolvedValue({ version: 'dossier1', status: 'COMPLETE', operations: [{ id: 'cut' }] });
  mocks.donors.mockImplementation(async () => ({ context: { commande_id: 10, client_id: '195', article_id: 'article1' },
    donors: [{ allocation_id: 2, technical_version_id: 'version1', protected_due_date: '2026-10-14' }],
    response: { free_quantity: '0', preview_hash: 'donor1', donors: [{ reservation_id: 'reservation1', proposed_quantity: '10' }] } }));
  mocks.snapshot.mockImplementation(async () => ({ apiVersion: 2, revision: '7', activation: 'COMMIT', nextCursor: null,
    tasks: [{ id: 'op:cut', source: 'OPERATION', operationId: 'cut', programmingId: null, ofId: 101, orderId: 20, quantity: 10,
      version: '1', readiness: 'READY', commitment: 'COMMITTED', committed: { start: at(8), end: at(9) }, actual: null,
      resourceIds: ['machine:1'], eligibleResourceIds: ['machine:1'], blockers: [], earliestStart: null, createdAt: at(6), priority: 0,
      estimate: { remainingMinutes: 60 }, locked: false }], resources: [{ id: 'machine:1', version: '1', availability: [{ start: at(6), end: at(20) }] }],
    dependencies: [], demands: [], sources: [], allocations: [], coverageAvailable: false }));
});
afterEach(() => vi.useRealTimers());
const args = async () => ({ requestId: id, expectedVersion: version, previewHash: (await previewUrgencyApproval(id)).preview_hash,
  idempotencyKey: '4c0dc721-cb68-4990-8ca7-b4d525ad15d3', audit });

describe('planner recovery approval persistence', () => {
  it('previews without writing, excluding only this request from the protected donor calculation', async () => {
    expect(await previewUrgencyApproval(id)).toMatchObject({ can_approve: true, can_withdraw: false });
    expect(mocks.donors).toHaveBeenCalledWith(expect.anything(),1,'10',{ requestId: id, sourceReservationIds: ['reservation1'] });
    expect(mocks.query.mock.calls.some(([sql]) => /INSERT|UPDATE/.test(sql))).toBe(false);
    expect(mocks.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  });
  it('records an immutable approval and audits it without moving stock or other operations', async () => {
    const input = await args(); mocks.query.mockClear();
    expect(await approveUrgencyRecovery(input)).toMatchObject({ replayed: false, approval: { status: 'APPROVED', request_version: 2, can_withdraw: false } });
    expect(mocks.query.mock.calls[1][0]).toBe('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    expect(mocks.query.mock.calls.some(([sql]) => /UPDATE public\.(stock_|planning_|commande_)/.test(sql))).toBe(false);
    expect(mocks.audit).toHaveBeenCalledOnce(); expect(mocks.ofAudit).toHaveBeenCalledOnce(); expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.at(-1)![0]).toBe('COMMIT');
  });
  it('keeps the business fingerprint stable when only approval metadata changes', async () => {
    const input = await args(); await approveUrgencyRecovery(input);
    expect((await previewUrgencyApproval(id)).preview_hash).toBe(input.previewHash);
  });
  it('replays the same approval without a second decision and rejects key reuse', async () => {
    const input = await args(); await approveUrgencyRecovery(input);
    expect(await approveUrgencyRecovery(input)).toMatchObject({ replayed: true });
    expect(mocks.audit).toHaveBeenCalledOnce();
    await expect(approveUrgencyRecovery({ ...input, expectedVersion: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('rejects a stale request version before writing an approval', async () => {
    const input = await args(); version = 2;
    await expect(approveUrgencyRecovery(input)).rejects.toMatchObject({ code: 'URGENCY_APPROVAL_CHANGED' });
    expect(approval).toBeUndefined(); expect(mocks.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
  });
  it('rejects changed stock evidence', async () => {
    const input = await args(); mocks.donors.mockResolvedValueOnce({ context: { client_id: '195', article_id: 'article1' },
      donors: [], response: { free_quantity: '0', preview_hash: 'changed', donors: [] } });
    await expect(approveUrgencyRecovery(input)).rejects.toMatchObject({ code: 'URGENCY_APPROVAL_CHANGED' }); expect(approval).toBeUndefined();
  });
  it('refuses incomplete technical preparation even with a current preview', async () => {
    mocks.dossier.mockResolvedValue({ version: 'dossier1', status: 'INCOMPLETE', operations: [{ id: 'cut' }] });
    await expect(approveUrgencyRecovery(await args())).rejects.toMatchObject({ code: 'URGENCY_APPROVAL_NOT_READY' }); expect(approval).toBeUndefined();
  });
  it('returns a recoverable conflict for concurrent changes', async () => {
    const input = await args(); mocks.query.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes('FOR UPDATE')) throw Object.assign(new Error('serialization'),{ code: '40001' });
      return defaultQuery(sql,values);
    });
    await expect(approveUrgencyRecovery(input)).rejects.toMatchObject({ status: 409, code: 'URGENCY_APPROVAL_BUSY' });
    expect(approval).toBeUndefined(); expect(mocks.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
  });
  it('does not reopen a cancelled request', async () => {
    status = 'CANCELLED'; await expect(previewUrgencyApproval(id)).rejects.toMatchObject({ code: 'URGENCY_REQUEST_CLOSED' });
  });
});
