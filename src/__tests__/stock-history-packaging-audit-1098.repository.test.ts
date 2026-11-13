import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coverageFingerprint } from '../module/production/domain/of-material';

const fixture = vi.hoisted(() => ({
    query: vi.fn(), release: vi.fn(), enqueue: vi.fn(), quality: vi.fn(),
    activeLabel: vi.fn(), entity: vi.fn(), label: vi.fn(), labelAudit: vi.fn(),
    scope: 'OLD', remaining: 12, previous: null as null | { id: string; request_hash: string },
    auditFailure: false,
}));
vi.mock('../config/database', () => ({ default: { connect: async () => ({ query: fixture.query, release: fixture.release }) } }));
vi.mock('../shared/realtime/realtime-outbox.service', () => ({ enqueueAuditNew: fixture.enqueue }));
vi.mock('../module/qualite/repository/quality-operational-gate.repository', () => ({ assertOperationalLotQualityEligibility: fixture.quality }));
vi.mock('../module/identification/identification.repository', () => ({
    repoFindActiveLabel: fixture.activeLabel, repoFindEntity: fixture.entity,
    repoInsertLabel: fixture.label, repoInsertAudit: fixture.labelAudit,
}));

import { appendLegacyDocument } from '../module/stock/repository/legacy-documents.repository';
import { createFinishedPackaging } from '../module/stock/repository/finished-packaging.repository';

const lotId = '00000000-0000-4000-8000-000000000101';
const actor = 7;
const reference = {
    idempotencyKey: '00000000-0000-4000-8000-000000000201', type: 'AUTRE' as const,
    label: 'Fictive historical source', location: '\\\\archive\\recette\\old.txt', reason: 'Documented Test recipe only',
};
const packaging = { idempotencyKey: '00000000-0000-4000-8000-000000000202', quantity: 10, reason: 'Pack the conforming fictive pieces' };

beforeEach(() => {
    vi.resetAllMocks();
    fixture.scope = 'OLD'; fixture.remaining = 12; fixture.previous = null; fixture.auditFailure = false;
    fixture.enqueue.mockResolvedValue(undefined); fixture.quality.mockResolvedValue(undefined);
    fixture.activeLabel.mockResolvedValue({ id: 'existing-label' });
    fixture.query.mockImplementation(async (raw: string, values: unknown[] = []) => {
        const sql = raw.replace(/\s+/g, ' ').trim();
        if (sql.startsWith('INSERT INTO public.erp_audit_logs') || sql.startsWith('INSERT INTO erp_audit_logs')) {
            // Observed Test/Prod schema: event_type is NOT NULL without a default.
            if (!sql.split('VALUES')[0].includes('event_type')) throw Object.assign(new Error('event_type is required'), { code: '23502' });
            if (fixture.auditFailure) throw new Error('audit unavailable');
            expect(values[1]).toBe('ACTION');
            return { rows: [{ id: '9001', created_at: '2026-10-10T15:00:00Z' }] };
        }
        if (sql.startsWith('SELECT request_hash,id::text FROM public.old_stock_document_references')
            || sql.startsWith('SELECT id::text,request_hash FROM public.finished_lot_packaging')) return { rows: fixture.previous ? [fixture.previous] : [] };
        if (sql.startsWith('SELECT COALESCE(origin_stock_scope')) return { rows: [{ scope: fixture.scope }] };
        if (sql.startsWith('INSERT INTO public.old_stock_document_references')) return { rows: [{ id: 'reference-1' }] };
        if (sql.startsWith('SELECT o.id::int AS')) return { rows: [{ ofId: 92, number: 'OF-92', hash: 'frozen-technical-hash', policy: { mode: 'GLOBAL', lotSize: null }, received: fixture.remaining, versionId: null }] };
        if (sql.startsWith('SELECT l.id::text,l.lot_code')) return { rows: [{ id: lotId, label: 'LOT-101', articleCode: 'ART-101', articleDesignation: 'Fictive part', scope: 'NEW', physical: fixture.remaining, index: 'A', internalVersion: 1 }] };
        if (sql.startsWith('SELECT p.id::text,p.quantity')) return { rows: [] };
        if (sql.startsWith('INSERT INTO public.finished_lot_packaging')) return { rows: [{ id: 'packaging-1' }] };
        return { rows: [] };
    });
});

const statements = () => fixture.query.mock.calls.map(([sql]) => String(sql).trim());
const auditValues = () => fixture.query.mock.calls.find(([sql]) => /INSERT INTO (?:public\.)?erp_audit_logs/.test(String(sql)))?.[1] as unknown[];

describe('historical OLD references use the canonical transactional audit', () => {
    it('commits the reference and ACTION audit with the same transaction and durable notification', async () => {
        await expect(appendLegacyDocument(lotId, reference, actor)).resolves.toEqual({ id: 'reference-1', replayed: false });
        expect(auditValues()).toMatchObject({ 0: actor, 1: 'ACTION', 2: 'stock.old-document.append', 4: 'LOT', 5: lotId });
        expect(JSON.parse(String(auditValues()[13]))).toEqual({ referenceId: 'reference-1', type: 'AUTRE', reason: reference.reason });
        expect(fixture.enqueue).toHaveBeenCalledWith(expect.objectContaining({ query: fixture.query }), { auditId: '9001' });
        expect(statements().at(-1)).toBe('COMMIT'); expect(fixture.release).toHaveBeenCalledOnce();
    });
    it('replays the exact request without duplicating the reference or audit', async () => {
        fixture.previous = { id: 'reference-1', request_hash: coverageFingerprint({ lotId, command: reference, actor }) };
        await expect(appendLegacyDocument(lotId, reference, actor)).resolves.toEqual({ id: 'reference-1', replayed: true });
        expect(statements().some(s => s.startsWith('INSERT'))).toBe(false); expect(fixture.enqueue).not.toHaveBeenCalled();
    });
    it('refuses a reused key with a different request', async () => {
        fixture.previous = { id: 'reference-1', request_hash: 'different' };
        await expect(appendLegacyDocument(lotId, reference, actor)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
        expect(statements().at(-1)).toBe('ROLLBACK');
    });
    it('refuses a NEW lot before inserting reference or audit', async () => {
        fixture.scope = 'NEW';
        await expect(appendLegacyDocument(lotId, reference, actor)).rejects.toMatchObject({ code: 'OLD_STOCK_REQUIRED' });
        expect(statements().some(s => s.startsWith('INSERT'))).toBe(false); expect(statements().at(-1)).toBe('ROLLBACK');
    });
    it('rolls back the reference when audit persistence fails', async () => {
        fixture.auditFailure = true;
        await expect(appendLegacyDocument(lotId, reference, actor)).rejects.toThrow('audit unavailable');
        expect(statements().at(-1)).toBe('ROLLBACK'); expect(statements()).not.toContain('COMMIT'); expect(fixture.release).toHaveBeenCalledOnce();
    });
    it('rolls back both writes when durable audit delivery fails', async () => {
        fixture.enqueue.mockRejectedValueOnce(new Error('outbox unavailable'));
        await expect(appendLegacyDocument(lotId, reference, actor)).rejects.toThrow('outbox unavailable');
        expect(statements().at(-1)).toBe('ROLLBACK'); expect(statements()).not.toContain('COMMIT');
    });
});

describe('finished packaging preserves quality and audit atomicity', () => {
    it('commits packaging and its ACTION audit without moving physical stock', async () => {
        await expect(createFinishedPackaging(lotId, packaging, actor)).resolves.toEqual({ id: 'packaging-1', replayed: false });
        expect(fixture.quality).toHaveBeenCalledWith(expect.objectContaining({ lotId, qty: 10, purpose: 'RESERVE' }));
        expect(auditValues()).toMatchObject({ 0: actor, 1: 'ACTION', 2: 'stock.finished-packaging.create', 4: 'LOT', 5: lotId });
        expect(JSON.parse(String(auditValues()[13]))).toEqual({ packagingId: 'packaging-1', portions: [10], reason: packaging.reason });
        expect(fixture.enqueue).toHaveBeenCalledOnce(); expect(statements().at(-1)).toBe('COMMIT');
        expect(statements().some(s => /^\s*(UPDATE|INSERT)\s+(?:INTO\s+)?public\.stock_(?:batches|ledger|movements)/.test(s))).toBe(false);
    });
    it('replays existing packaging before touching quality or writing a second audit', async () => {
        fixture.previous = { id: 'packaging-1', request_hash: coverageFingerprint({ lotId, body: packaging, actor }) };
        await expect(createFinishedPackaging(lotId, packaging, actor)).resolves.toEqual({ id: 'packaging-1', replayed: true });
        expect(fixture.quality).not.toHaveBeenCalled(); expect(fixture.enqueue).not.toHaveBeenCalled(); expect(statements().some(s => s.startsWith('INSERT'))).toBe(false);
    });
    it('rejects an idempotency collision', async () => {
        fixture.previous = { id: 'packaging-1', request_hash: 'different' };
        await expect(createFinishedPackaging(lotId, packaging, actor)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
        expect(statements().at(-1)).toBe('ROLLBACK');
    });
    it('keeps the quality gate authoritative', async () => {
        fixture.quality.mockRejectedValueOnce(new Error('quality blocked'));
        await expect(createFinishedPackaging(lotId, packaging, actor)).rejects.toThrow('quality blocked');
        expect(statements().some(s => s.startsWith('INSERT'))).toBe(false); expect(statements().at(-1)).toBe('ROLLBACK');
    });
    it('refuses a quantity beyond the physical remainder', async () => {
        await expect(createFinishedPackaging(lotId, { ...packaging, quantity: 13 }, actor)).rejects.toMatchObject({ code: 'PACKAGING_QUANTITY_CHANGED' });
        expect(statements().some(s => s.startsWith('INSERT'))).toBe(false); expect(statements().at(-1)).toBe('ROLLBACK');
    });
    it('rolls back packaging and identification when audit persistence fails', async () => {
        fixture.activeLabel.mockResolvedValueOnce(null); fixture.entity.mockResolvedValueOnce({ canonical_code: 'LOT-101' }); fixture.label.mockResolvedValueOnce({ id: 'new-label' }); fixture.auditFailure = true;
        await expect(createFinishedPackaging(lotId, packaging, actor)).rejects.toThrow('audit unavailable');
        expect(fixture.labelAudit).toHaveBeenCalledOnce(); expect(statements().at(-1)).toBe('ROLLBACK'); expect(statements()).not.toContain('COMMIT');
    });
});
