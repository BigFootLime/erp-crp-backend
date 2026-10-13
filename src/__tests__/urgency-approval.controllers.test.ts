import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ preview: vi.fn(), approve: vi.fn() }));
vi.mock('../module/planning/services/urgency-approval.service', () => ({ svcPreviewUrgencyApproval: mocks.preview, svcApproveUrgencyRecovery: mocks.approve }));
vi.mock('../module/planning/controllers/planning-central.controller', () => Object.fromEntries([
  'centralApply','centralGetSimulation','centralSimulate','centralSnapshot','centralStatus','centralUnplan','centralObservations',
  'centralPreview','centralWorkshopCalendar','centralSetWorkshopCalendar'].map(name => [name,vi.fn()])));
vi.mock('../module/planning/controllers/planning-master-plan.controller', () => ({ masterPlan: vi.fn() }));
vi.mock('../module/planning/controllers/planning.controller', () => ({ buildAuditContext: (req: express.Request) => ({ user_id: req.user!.id, role: req.user!.role }) }));
import centralRouter from '../module/planning/routes/planning-central.routes';
import { validationErrorMiddleware } from '../module/auth/middlewares/validationError.middleware';

const id = 'cfc82e22-f9cc-40a6-b9c7-fb9d5f52ba63', key = '6dcae4b0-bb8c-4d75-9dcb-270763a5e5ab';
const body = { expected_version: 1, preview_hash: 'a'.repeat(64) };
function app() {
  const server = express(); server.use(express.json());
  server.use((req,_res,next) => { if (req.get('x-test-role')) req.user = { id: 8, role: req.get('x-test-role') } as Express.User; next(); });
  server.use('/planning/v2',centralRouter); server.use(validationErrorMiddleware);
  server.use(((error,_req,res,_next) => res.status(error.status ?? 500).json({ code: error.code })) as ErrorRequestHandler);
  return server;
}
beforeEach(() => { vi.clearAllMocks(); mocks.preview.mockResolvedValue({ can_approve: true, can_withdraw: false });
  mocks.approve.mockResolvedValue({ approval: { status: 'APPROVED', can_withdraw: false }, replayed: false }); });

describe('approval routes under the planning capability', () => {
  it.each([[undefined,401],['Stock',403],['Operateur atelier',403]] as const)('requires a planner for %s', async (role,expected) => {
    let get = request(app()).get(`/planning/v2/urgency-requests/${id}/approval-preview`);
    let post = request(app()).post(`/planning/v2/urgency-requests/${id}/approve`).send(body);
    if (role) { get = get.set('x-test-role',role); post = post.set('x-test-role',role); }
    expect((await get).status).toBe(expected); expect((await post).status).toBe(expected);
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('returns a private preview for an authorized planner', async () => {
    const response = await request(app()).get(`/planning/v2/urgency-requests/${id}/approval-preview`).set('x-test-role','Planification');
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toContain('no-store');
    expect(mocks.preview).toHaveBeenCalledWith(id); expect(response.body.can_withdraw).toBe(false);
  });
  it.each([undefined,'not-a-uuid'])('requires a valid idempotency key: %s', async keyValue => {
    let post = request(app()).post(`/planning/v2/urgency-requests/${id}/approve`).set('x-test-role','Planification');
    if (keyValue) post = post.set('Idempotency-Key',keyValue);
    expect((await post.send(body)).status).toBe(400); expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('rejects client-forged status or withdrawal permission', async () => {
    const response = await request(app()).post(`/planning/v2/urgency-requests/${id}/approve`).set('x-test-role','Planification')
      .set('Idempotency-Key',key).send({ ...body, status: 'APPROVED', can_withdraw: true });
    expect(response.status).toBe(400); expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('preserves the acting planner and versioned review', async () => {
    const response = await request(app()).post(`/planning/v2/urgency-requests/${id}/approve`).set('x-test-role','Planification')
      .set('Idempotency-Key',key).send(body);
    expect(response.status).toBe(201);
    expect(mocks.approve).toHaveBeenCalledWith({ requestId: id, expectedVersion: 1, previewHash: body.preview_hash,
      idempotencyKey: key, audit: expect.objectContaining({ user_id: 8, user_role: 'Planification' }) });
  });
  it('returns an existing approval on retry', async () => {
    mocks.approve.mockResolvedValue({ approval: { status: 'APPROVED' }, replayed: true });
    expect((await request(app()).post(`/planning/v2/urgency-requests/${id}/approve`).set('x-test-role','Planification')
      .set('Idempotency-Key',key).send(body)).status).toBe(200);
  });
});
