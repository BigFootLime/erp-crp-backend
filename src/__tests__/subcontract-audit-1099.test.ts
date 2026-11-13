import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), enqueue: vi.fn(), quality: vi.fn(),
  flows: vi.fn(), auditFailure: false, lotStatus: 'LIBERE', custodyBalance: 0 }));
vi.mock('../config/database', () => ({ default: {
  query: f.query, connect: async () => ({ query: f.query, release: f.release }),
} }));
vi.mock('../shared/realtime/realtime-outbox.service', () => ({ enqueueAuditNew: f.enqueue }));
vi.mock('../module/receptions/repository/receipt-processing-guard', () => ({ assertReceiptProcessingClosed: vi.fn() }));
vi.mock('../module/subcontract/subcontract-flow.repository', () => ({
  subcontractFlowInstalled: async () => false, readSubcontractFlows: f.flows,
}));
vi.mock('../module/qualite/repository/quality-operational-gate.repository', () => ({ assertReceiptLotQualityEligibility: f.quality }));
// Exercise the transfer callback without replaying the separately covered planning command ledger.
vi.mock('../module/planning/repository/planning-command.repository', () => ({
  withPlanningCommand: async (_actor: unknown, _key: string, _name: string, _body: unknown,
    command: (tx: { query: typeof f.query }) => Promise<unknown>) => command({ query: f.query }),
}));

import router from '../module/subcontract/subcontract.routes';
import { transferSubcontractReturn } from '../module/subcontract/subcontract-flow.service';
import type { SubcontractTransferInput } from '../module/subcontract/subcontract-flow.validators';

const packageId = '00000000-0000-4000-8000-000000000101';
const lotId = '00000000-0000-4000-8000-000000000102';
const operationId = '00000000-0000-4000-8000-000000000103';
const successorId = '00000000-0000-4000-8000-000000000104';
const returnId = '00000000-0000-4000-8000-000000000105';
const lineId = '00000000-0000-4000-8000-000000000106';
const evidenceId = '00000000-0000-4000-8000-000000000107';
const version = 'a'.repeat(64);
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 7, role: 'Production Achat' } as typeof req.user; next(); });
app.use('/subcontract', router);
app.use((error: Error & { status?: number; statusCode?: number; code?: string }, _req: express.Request,
  res: express.Response, _next: express.NextFunction) => {
  res.status(error.statusCode ?? error.status ?? 500).json({ code: error.code, message: error.message });
});

beforeEach(() => {
  vi.resetAllMocks(); f.auditFailure = false; f.lotStatus = 'LIBERE'; f.custodyBalance = 0;
  f.enqueue.mockResolvedValue('outbox-1'); f.quality.mockResolvedValue(undefined);
  f.flows.mockResolvedValue([{ packageId, version, returns: [{ id: returnId, transferable: 4, transferred: 0 }] }]);
  f.query.mockImplementation(async (raw: string, values: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    if (/INSERT INTO (?:public\.)?erp_audit_logs/.test(sql)) {
      if (!sql.split('VALUES')[0].includes('event_type')) throw Object.assign(new Error('event_type is required'), { code: '23502' });
      if (f.auditFailure) throw new Error('audit unavailable');
      expect(values[1]).toBe('ACTION');
      return { rows: [{ id: '9002', created_at: '2026-10-10T15:00:00Z' }] };
    }
    if (sql.startsWith('INSERT INTO public.subcontract_work_packages') || sql.startsWith('SELECT p.*,l.type')
      || sql.startsWith('SELECT p.*,o.quantite_lancee') || sql.startsWith('UPDATE public.subcontract_work_packages')) {
      return { rows: [{ id: packageId, status: 'SENT', of_status: 'EN_COURS', unit: 'U', qty_planned: 10,
        type: 'SOUS_TRAITANCE', statut_ligne: 'ACTIVE', order_status: 'ENVOYEE',
        of_operation_id: operationId, supplier_order_line_id: lineId, row_version: 1 }] };
    }
    if (sql.startsWith('SELECT id,package_id,event_type')) return { rows: [] };
    if (sql.startsWith('SELECT lot_status')) return { rows: [{ lot_status: f.lotStatus }] };
    if (sql.startsWith('SELECT of_id FROM')) return { rows: [{ of_id: 101 }] };
    if (sql.startsWith('SELECT COALESCE(sum(qty) FILTER')) return { rows: [{ qty: f.custodyBalance }] };
    if (sql.startsWith('SELECT COALESCE(sum(qty),0)')) return { rows: [{ qty: 0 }] };
    if (sql.startsWith('INSERT INTO public.subcontract_work_package_ledger')) return { rows: [{ id: 'ledger-1' }] };
    if (sql.startsWith('SELECT rl.lot_id')) return { rows: [{ lot_id: lotId, receipt_line_id: 'receipt-line-1' }] };
    if (sql.startsWith('WITH route AS')) return { rows: [{ id: successorId, label: 'Next operation', minimum: null }] };
    if (sql.startsWith('SELECT op.status::text')) return { rows: [{ status: 'PENDING', processed: 0 }] };
    if (sql.startsWith('SELECT id,released_quantity')) return { rows: [{ id: 'batch-1', qty: 4 }] };
    return { rows: [] };
  });
});

const auditValues = () => f.query.mock.calls.find(([sql]) => /INSERT INTO (?:public\.)?erp_audit_logs/.test(String(sql)))?.[1] as unknown[];
const statements = () => f.query.mock.calls.map(([sql]) => String(sql).trim());
const create = () => request(app).post('/subcontract').send({ supplier_order_line_id: lineId,
  of_operation_id: operationId, ged_evidence_document_id: evidenceId, unit: 'u', qty_planned: 10 });
const transfer = (action: SubcontractTransferInput['action'] = 'RELEASE', quantity = 2) =>
  transferSubcontractReturn(packageId, { return_id: returnId, successor_operation_id: successorId,
    quantity, expected_version: version, reason: 'Fictive recipe only', action },
  { user_id: 7, role: 'Production Achat', request_id: null, correlation_id: null }, 'transfer-recipe-1');

describe('subcontract custody writes use the complete canonical audit', () => {
  it.each(['CREATE', 'ISSUE', 'RETURN', 'CLOSED', 'CANCELLED'])('persists ACTION and its outbox for %s', async (action) => {
    f.lotStatus = action === 'RETURN' ? 'QUARANTAINE' : 'LIBERE';
    f.custodyBalance = action === 'RETURN' ? 10 : 0;
    const response = action === 'CREATE' ? await create()
      : action === 'ISSUE' || action === 'RETURN'
        ? await request(app).post(`/subcontract/${packageId}/${action === 'ISSUE' ? 'issues' : 'returns'}`)
          .set('Idempotency-Key', 'custody-recipe-1').send({ lot_id: lotId, unit: 'u', qty: 2 })
        : await request(app).post(`/subcontract/${packageId}/${action === 'CLOSED' ? 'close' : 'cancel'}`)
          .send({ expected_row_version: 1, reason: 'Fictive recipe only' });
    expect(response.status).toBe(action === 'CLOSED' || action === 'CANCELLED' ? 200 : 201);
    expect(auditValues()).toMatchObject({ 0: 7, 1: 'ACTION', 2: action, 3: 'subcontract',
      4: 'SUBCONTRACT_WORK_PACKAGE', 5: packageId });
    expect(f.enqueue).toHaveBeenCalledWith(expect.objectContaining({ query: f.query }), { auditId: '9002' });
    expect(statements().at(-1)).toBe('COMMIT'); expect(f.release).toHaveBeenCalledOnce();
  });
  it('rolls back creation when audit persistence fails', async () => {
    f.auditFailure = true;
    expect((await create()).status).toBe(500);
    expect(statements().at(-1)).toBe('ROLLBACK'); expect(statements()).not.toContain('COMMIT');
  });
  it('rolls back custody when durable audit notification fails', async () => {
    f.enqueue.mockRejectedValueOnce(new Error('outbox unavailable'));
    expect((await create()).status).toBe(500);
    expect(statements().at(-1)).toBe('ROLLBACK'); expect(statements()).not.toContain('COMMIT');
  });
});

describe('subcontract return transfer preserves quality and the audit failure boundary', () => {
  it.each(['RELEASE', 'RETURN'] as const)('audits TRANSFER_%s with unchanged receipt and quantity details', async (action) => {
    await expect(transfer(action)).resolves.toMatchObject({ package_id: packageId, action, quantity: 2 });
    expect(auditValues()).toMatchObject({ 0: 7, 1: 'ACTION', 2: `TRANSFER_${action}`, 5: packageId });
    expect(JSON.parse(String(auditValues()[13]))).toMatchObject({ action, quantity: 2,
      return_id: returnId, successor_operation_id: successorId, idempotency_key: 'transfer-recipe-1' });
    expect(f.enqueue).toHaveBeenCalledOnce();
    expect(f.quality).toHaveBeenCalledTimes(action === 'RELEASE' ? 1 : 0);
  });
  it('retains the receipt quality gate before transfer or audit', async () => {
    f.quality.mockRejectedValueOnce(new Error('receipt not released'));
    await expect(transfer()).rejects.toThrow('receipt not released');
    expect(statements().some(s => s.startsWith('INSERT'))).toBe(false);
  });
  it('propagates audit persistence failure after transfer insertion', async () => {
    f.auditFailure = true;
    await expect(transfer()).rejects.toThrow('audit unavailable');
    expect(statements().some(s => s.startsWith('INSERT INTO public.production_transfer_batches'))).toBe(true);
  });
  it('propagates outbox failure to the owning planning transaction', async () => {
    f.enqueue.mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(transfer()).rejects.toThrow('outbox unavailable');
  });
});
