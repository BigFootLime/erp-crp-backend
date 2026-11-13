import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../utils/httpError';
import { requireOfCapability } from '../middlewares/of-versioning-authorization.middleware';
import { validationErrorMiddleware } from '../../auth/middlewares/validationError.middleware';
import { errorHandler } from '../../../middlewares/errorHandler';

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), rights: vi.fn() }));
vi.mock('./consumable-procurement.controller', () => ({ consumableRights: mocks.rights }));
vi.mock('./production.controller', () => ({ buildAuditContext: () => ({ user_id: 7 }) }));
vi.mock('../../planning/repository/planning-procurement.repository', async importOriginal => ({
  ...await importOriginal<typeof import('../../planning/repository/planning-procurement.repository')>(),
  readPlanningProcurement: mocks.read, savePlanningProcurement: mocks.save,
}));
import { readOfMaterialReview, saveOfMaterialReview } from './of-material-review.controller';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.header('x-test-role');
  if (role) req.user = { id: 7, role, username: 'reader', email: 'reader@invalid.example' };
  next();
});
app.get('/ofs/:id/material-review', requireOfCapability('read'), readOfMaterialReview);
app.post('/ofs/:id/material-review', requireOfCapability('read'), saveOfMaterialReview);
app.use(validationErrorMiddleware);
app.use(errorHandler);

const path = '/ofs/5/material-review';
const data = { of: { id: 5, number: 'OF-5' }, version: 'stock-version', suppliers: [],
  entries: [{ key: 'MATIERE:source', kind: 'MATIERE' }, { key: 'PRESTATION:other', kind: 'PRESTATION' }] };
const body = { expectedVersion: 'stock-version', idempotencyKey: '11111111-1111-4111-8111-111111111111',
  scope: 'material', deferMaterialPurchase: true,
  entries: [{ key: 'MATIERE:source', due: null, supplierId: null, catalogueId: null }] };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rights.mockResolvedValue({ purchase: false, prices: false, reserve: false, withdraw: false });
  mocks.read.mockResolvedValue(data);
  mocks.save.mockResolvedValue({ ...data, messages: [], orders: [] });
});

describe('Production material review without planning or Quality privileges', () => {
  it.each(['get', 'post'] as const)('requires authentication on %s', async method => {
    expect((await request(app)[method](path).send(body)).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(['get', 'post'] as const)('requires OF access on %s', async method => {
    expect((await request(app)[method](path).set('x-test-role', 'Employe').send(body)).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('lets an OF reader inspect the material version without purchase, stock or planning rights', async () => {
    const response = await request(app).get(path).set('x-test-role', 'Operateur Atelier');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ version: 'stock-version', canSave: false, canPurchase: false });
    expect(response.body.entries).toEqual([data.entries[0]]);
    expect(mocks.read).toHaveBeenCalledWith(5, false);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('refuses supplier-choice writes by a reader before parsing or writing', async () => {
    const response = await request(app).post(path).set('x-test-role', 'Operateur Atelier').send({});
    expect(response.status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('preserves price rights and delegates the scoped, deferred purchase-authorized review', async () => {
    mocks.rights.mockResolvedValue({ purchase: true, prices: true });
    const read = await request(app).get(path).set('x-test-role', 'Production');
    expect(read.body).toMatchObject({ canSave: true, canPurchase: true });
    expect(mocks.read).toHaveBeenCalledWith(5, true);
    const response = await request(app).post(path).set('x-test-role', 'Production').send(body);
    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(5, body, { user_id: 7 }, true);
    expect(response.body.entries).toEqual([data.entries[0]]);
  });
  it.each([
    { scope: 'treatment', operationId: '22222222-2222-4222-8222-222222222222' },
    { deferMaterialPurchase: false }, { deferMaterialPurchase: undefined },
    { operationId: '22222222-2222-4222-8222-222222222222' },
    { extra: 'forged' }, { idempotencyKey: 'invalid' },
    { entries: [{ ...body.entries[0], key: 'PRESTATION:other' }] },
  ])('refuses a forged or incomplete review before the transaction: %j', async override => {
    mocks.rights.mockResolvedValue({ purchase: true, prices: false });
    const response = await request(app).post(path).set('x-test-role', 'Production').send({ ...body, ...override });
    expect(response.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('preserves the repository stale-review conflict', async () => {
    mocks.rights.mockResolvedValue({ purchase: true, prices: false });
    mocks.save.mockRejectedValue(new HttpError(409, 'PLANNING_SUPPLY_CHANGED', 'Actualisez la préparation.'));
    expect((await request(app).post(path).set('x-test-role', 'Production').send(body)).status).toBe(409);
  });
});
