import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../module/audit-logs/services/audit-logs.service", () => ({ svcListAuditLogs: vi.fn(), svcCreateAuditLog: vi.fn() }));
import * as service from "../module/audit-logs/services/audit-logs.service";
import { listAuditLogs } from "../module/audit-logs/controllers/audit-logs.controller";
const app = express();
app.use((req, _res, next) => { req.user = { id: 91, username: "FIXTURE", email: "fixture@example.invalid", role: "Employee" }; req.sensitiveCapabilities = ["audit.read"]; next(); });
app.get("/audit", listAuditLogs);
app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(503).json({ code: "AUDIT_UNAVAILABLE" }); });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(service.svcListAuditLogs).mockResolvedValue({ items: [], total: 0 }); vi.mocked(service.svcCreateAuditLog).mockResolvedValue({ id: "1", created_at: new Date().toISOString() }); });
describe("sensitive audit consultation trace", () => {
  it("records the reader and result bounds without copying search contents", async () => {
    const response = await request(app).get("/audit?q=private-search@example.invalid&page=2&pageSize=10");
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.svcCreateAuditLog).toHaveBeenCalledWith(expect.objectContaining({ user_id: 91, body: expect.objectContaining({ action: "AUDIT_LOG_READ", path: "/audit", details: { scope: "global", page: 2, page_size: 10, returned_rows: 0 } }) }));
    expect(JSON.stringify(vi.mocked(service.svcCreateAuditLog).mock.calls)).not.toContain("private-search");
  });
  it("does not return sensitive records when the consultation trace cannot be committed", async () => {
    vi.mocked(service.svcCreateAuditLog).mockRejectedValue(new Error("synthetic audit outage"));
    const response = await request(app).get("/audit");
    expect(response.status).toBe(503); expect(response.body.items).toBeUndefined();
  });
});
