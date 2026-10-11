import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../utils/httpError";
const mocks = vi.hoisted(() => ({ context: vi.fn(), capabilities: [] as string[] }));
vi.mock("../module/auth/middlewares/auth.middleware", () => ({ authenticateToken: (req: express.Request, res: express.Response, next: express.NextFunction) => req.headers['x-anonymous'] ? res.status(401).json({ code: 'UNAUTHORIZED' }) : next() }));
vi.mock("../module/qualite/middlewares/quality-authorization.middleware", () => ({ requireQualityCapability: (cap: string) => {
  mocks.capabilities.push(cap);
  return (req: express.Request, res: express.Response, next: express.NextFunction) => req.headers['x-no-quality'] ? res.status(403).json({ code: 'FORBIDDEN' }) : next();
} }));
vi.mock("../module/qualite/services/quality-360.service", async (original) => ({ ...await original<object>(), svcOfOperationExecutionContext: mocks.context }));
import router from "../module/qualite/routes/quality-360.routes";
const app = express(); app.use(express.json()); app.use('/qualite/v2', router);
app.use((error: { status?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ code: error.code }));
const operation = '11111111-1111-4111-8111-111111111111';
const url = `/qualite/v2/of/103/operations/${operation}/execution-context`;
beforeEach(() => { mocks.context.mockReset(); });
describe("Session OF quality context route", () => {
  it("requires authentication and the existing execution capability", async () => {
    expect((await request(app).get(url).set('x-anonymous', '1')).status).toBe(401);
    expect((await request(app).get(url).set('x-no-quality', '1')).status).toBe(403);
    expect(mocks.context).not.toHaveBeenCalled(); expect(mocks.capabilities).toContain('execution_run');
  });
  it("returns only the authoritative service context", async () => {
    const context = { source: { of_id: 103, source_id: operation, population: 4, unite: 'u' }, plan: { id: operation, code: 'PC-1275', version: 1 }, existing_execution: null };
    mocks.context.mockResolvedValue(context);
    const res = await request(app).get(url);
    expect(res.status).toBe(200); expect(res.body).toEqual(context); expect(mocks.context).toHaveBeenCalledWith(103, operation);
  });
  it("rejects invalid parameters before resolving production", async () => {
    expect((await request(app).get('/qualite/v2/of/103junk/operations/invalid/execution-context')).status).toBe(422);
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it("keeps actionable server scope conflicts", async () => {
    mocks.context.mockRejectedValue(new HttpError(409, 'QUALITY_OF_OPERATION_MISMATCH', 'Wrong operation'));
    const res = await request(app).get(url); expect(res.status).toBe(409); expect(res.body.code).toBe('QUALITY_OF_OPERATION_MISMATCH');
  });
});
