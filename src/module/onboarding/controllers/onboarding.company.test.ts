import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  enabled: true,
  directory: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  synchronize: vi.fn(),
}));
vi.mock("../../../config/database", () => ({ default: {} }));
vi.mock("../repository/onboarding.repository", () => ({
  readSetupCompanies: ports.read,
  saveSetupCompany: ports.save,
  saveSetupStep: vi.fn(),
}));
vi.mock("../services/onboarding.service", () => ({ getSetupStatus: vi.fn() }));
vi.mock("../../../shared-directory/site-runtime", () => ({
  sharedDirectoryClient: () => ({ call: ports.directory }),
}));
vi.mock("../../../shared-directory/company.projection", () => ({
  synchronizeDirectoryCompany: ports.synchronize,
}));
vi.mock("../../entreprises/runtime/company-runtime.config", () => ({
  companyRuntimeConfiguration: () => ({ enabled: ports.enabled }),
}));
import { companies, company } from "./onboarding.controller";

const billerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const input = {
  biller_id: null,
  expected_updated_at: null,
  biller_name: "Commercial fixture",
  street: "Fixture street",
  house_number: "",
  postal_code: "00000",
  city: "Fixture",
  country: "FR",
  phone: "",
  email: "billing@example.test",
  legal_form: "SAS",
  siret: "00000000000000",
  vat_number: "",
  share_capital: 0,
  rcs_city: "",
  rcs_number: "",
  late_penalty_rate: 10,
  recovery_indemnity: 40,
  effective_from: "2026-10-26",
};
function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.user = { id: 42, directory_session: "private-session" } as never;
    next();
  });
  server.get("/company", companies);
  server.put("/company", company);
  server.use(
    (
      error: { name?: string; status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(error.name === "ZodError" ? 400 : (error.status ?? 500))
        .json({ failed: true }),
  );
  return server;
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.enabled = true;
  ports.read.mockResolvedValue([
    { biller_id: billerId, biller_name: "Commercial fixture" },
  ]);
  ports.save.mockResolvedValue({ biller_id: billerId });
  ports.directory.mockResolvedValue({ biller_id: billerId });
});
describe("company-owned legal settings", () => {
  it("reads and saves only the fixed company's local legal identity", async () => {
    const server = app();
    const read = await request(server).get("/company");
    expect(read.body).toEqual([
      { biller_id: billerId, biller_name: "Commercial fixture" },
    ]);
    const save = await request(server)
      .put("/company")
      .set("Idempotency-Key", key)
      .send(input);
    expect(save.status).toBe(200);
    expect(ports.save).toHaveBeenCalledWith(input, 42, key);
    expect(ports.directory).not.toHaveBeenCalled();
    expect(ports.synchronize).not.toHaveBeenCalled();
  });
  it("keeps the existing common identity flow in legacy mode", async () => {
    ports.enabled = false;
    await request(app())
      .put("/company")
      .set("Idempotency-Key", key)
      .send(input);
    expect(ports.directory).toHaveBeenCalledWith("company-save", {
      directory_session: "private-session",
      input: { company: input, key },
    });
    expect(ports.synchronize).toHaveBeenCalledOnce();
    expect(ports.save).not.toHaveBeenCalled();
  });
  it("validates local identity and idempotency before making a change", async () => {
    expect((await request(app()).put("/company").send(input)).status).toBe(400);
    expect(
      (
        await request(app())
          .put("/company")
          .set("Idempotency-Key", key)
          .send({ ...input, email: "invalid" })
      ).status,
    ).toBe(400);
    expect(ports.save).not.toHaveBeenCalled();
    expect(ports.directory).not.toHaveBeenCalled();
  });
});
