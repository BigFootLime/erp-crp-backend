import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), admin: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: { query: mocks.query } }));
vi.mock("../../access-control/repository/access-control.repository", () => ({ repoIsSuperadmin: mocks.admin }));
import { requireCutoverParentAccess } from "./require-cutover-parent-access";
import { errorHandler } from "../../../middlewares/errorHandler";
const app = express();
app.use((req, _res, next) => { if (req.get("X-Fixture-User")) req.user = { id: 1 } as Express.Request["user"]; next(); });
app.all("/documents/:id", requireCutoverParentAccess, (_req, res) => res.json({ ok: true }));
app.all("/versions/:versionId/content", requireCutoverParentAccess, (_req, res) => res.json({ ok: true }));
app.use(errorHandler);
const id = "11111111-1111-4111-8111-111111111111";
describe("private cutover GED parent across existing transports", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.query.mockResolvedValue({ rows: [{ private: false }] }); mocks.admin.mockResolvedValue(false); });
  it("does no document lookup before the normal authentication guard", async () => {
    await request(app).get(`/documents/${id}`);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("preserves ordinary document behavior without granting any extra access", async () => {
    expect((await request(app).get(`/documents/${id}`).set("X-Fixture-User", "1")).status).toBe(200);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(["/documents/", "/versions/"])("blocks the private parent on %s for a non-SuperAdmin", async (path) => {
    mocks.query.mockResolvedValue({ rows: [{ private: true }] });
    const result = await request(app).post(`${path}${id}${path.includes("versions") ? "/content" : ""}`).set("X-Fixture-User", "1");
    expect(result.status).toBe(404);
    expect(result.body.code).toBe("GED_VERSION_NOT_FOUND");
  });
  it("permits only the current authoritative SuperAdmin grant", async () => {
    mocks.query.mockResolvedValue({ rows: [{ private: true }] }); mocks.admin.mockResolvedValue(true);
    expect((await request(app).get(`/documents/${id}`).set("X-Fixture-User", "1")).status).toBe(200);
    expect(mocks.admin).toHaveBeenCalledWith(1);
  });
});
