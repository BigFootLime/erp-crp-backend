import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();

  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });

  return {
    Pool: vi.fn(() => pool),
    __emitter__: emitter,
  };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; role: string }; headers?: Record<string, string | string[] | undefined> },
    _res: unknown,
    next: () => void
  ) => {
    const requestedRole = req.headers?.["x-test-role"];
    req.user = {
      id: 1,
      role: typeof requestedRole === "string" ? requestedRole : "Administrateur Systeme et Reseau",
    };
    next();
  },
  authorizeRole:
    (...roles: string[]) =>
    (req: { user?: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => unknown } }, next: () => void) => {
      if (req.user && roles.includes(req.user.role)) {
        next();
        return;
      }
      res.status(403).json({ error: "Acces interdit" });
    },
}));

import app from "../config/app";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();

  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.clientQuery.mockResolvedValue({ rows: [] });

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
});

describe("/api/v1/pieces-techniques", () => {
  it.each([
    "Employee | Method",
    "Employee | Responsable Programmation",
  ])("lets an authorized multi-role marker reach technical-version approval (%s)", async (role) => {
    const pieceId = "11111111-1111-4111-8111-111111111111";
    const versionId = "22222222-2222-4222-8222-222222222222";

    const res = await request(app)
      .patch(`/api/v1/pieces-techniques/${pieceId}/versions/${versionId}/status`)
      .set("x-test-role", role)
      .send({ next_statut: "APPLICABLE" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps technical-version approval closed to an unprivileged operator", async () => {
    const pieceId = "11111111-1111-4111-8111-111111111111";
    const versionId = "22222222-2222-4222-8222-222222222222";

    const res = await request(app)
      .patch(`/api/v1/pieces-techniques/${pieceId}/versions/${versionId}/status`)
      .set("x-test-role", "Employee | Opérateur atelier")
      .send({ next_statut: "APPLICABLE" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "PIECE_VERSION_APPROVAL_FORBIDDEN" });
  });

  it("keeps guided version publication closed to an unprivileged operator", async () => {
    const pieceId = "11111111-1111-4111-8111-111111111111";
    const versionId = "22222222-2222-4222-8222-222222222222";

    const res = await request(app)
      .post(`/api/v1/pieces-techniques/${pieceId}/versions/${versionId}/publish`)
      .set("x-test-role", "Employee | Opérateur atelier")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "PIECE_VERSION_APPROVAL_FORBIDDEN" });
  });

  it("accepts an already applicable version without a second state change", async () => {
    const pieceId = "11111111-1111-4111-8111-111111111111";
    const versionId = "22222222-2222-4222-8222-222222222222";
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM public.piece_technique_versions") && query.includes("FOR UPDATE")) {
        return { rows: [{ id: versionId, piece_technique_id: pieceId, statut: "APPLICABLE", updated_at: "2026-08-01T10:00:00.000Z" }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`/api/v1/pieces-techniques/${pieceId}/versions/${versionId}/publish`)
      .send({ expected_updated_at: "2026-08-01T10:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: versionId, statut: "APPLICABLE" });
    expect(mocks.clientQuery.mock.calls.some((call) => String(call[0]).includes("SET statut = 'EN_VALIDATION'"))).toBe(false);
    expect(mocks.clientQuery.mock.calls.some((call) => String(call[0]).includes("SET statut = 'OBSOLETE'"))).toBe(false);
  });

  it("updates date_effet on an applicable version so OF generation can resume", async () => {
    const pieceId = "11111111-1111-4111-8111-111111111111";
    const versionId = "22222222-2222-4222-8222-222222222222";
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM public.piece_technique_versions") && query.includes("FOR UPDATE")) {
        return { rows: [{ id: versionId, piece_technique_id: pieceId, statut: "APPLICABLE", updated_at: "2026-08-01T10:00:00.000Z", date_effet: "2026-09-01" }] };
      }
      if (query.includes("SET date_effet = $2::date")) {
        return { rows: [{ id: versionId, piece_technique_id: pieceId, statut: "APPLICABLE", date_effet: "2026-08-01" }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`/api/v1/pieces-techniques/${pieceId}/versions/${versionId}/publish`)
      .send({ date_effet: "2026-08-01" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ statut: "APPLICABLE", date_effet: "2026-08-01" });
    expect(mocks.clientQuery.mock.calls.some((call) => String(call[0]).includes("SET date_effet = $2::date"))).toBe(true);
  });

  it("refuses a future effective date before it can replace the current applicable version", async () => {
    const pieceId = "11111111-1111-4111-8111-111111111111";
    const versionId = "22222222-2222-4222-8222-222222222222";
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("FROM public.piece_technique_versions") && query.includes("FOR UPDATE")) {
        return { rows: [{ id: versionId, piece_technique_id: pieceId, statut: "EN_VALIDATION", updated_at: "2026-08-01T10:00:00.000Z", date_effet: "2099-01-01" }] };
      }
      if (query.includes("$1::date > CURRENT_DATE")) return { rows: [{ is_future: true }] };
      return { rows: [] };
    });

    const res = await request(app)
      .post(`/api/v1/pieces-techniques/${pieceId}/versions/${versionId}/publish`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "VERSION_EFFECTIVE_DATE_FUTURE", details: { date_effet: "2099-01-01" } });
    expect(mocks.clientQuery.mock.calls.some((call) => String(call[0]).includes("SET statut = 'OBSOLETE'"))).toBe(false);
  });

  it("applies the same future-date guard to the legacy status endpoint", async () => {
    const pieceId = "11111111-1111-4111-8111-111111111111";
    const versionId = "22222222-2222-4222-8222-222222222222";
    mocks.poolQuery.mockResolvedValue({
      rows: [{ statut: "EN_VALIDATION", updated_at: "2026-08-01T10:00:00.000Z", date_effet: "2099-01-01" }],
    });
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
      if (query.includes("piece_technique_versions")) {
        return { rows: [{ statut: "EN_VALIDATION", updated_at: "2026-08-01T10:00:00.000Z", date_effet: "2099-01-01" }] };
      }
      if (query.includes("$1::date > CURRENT_DATE")) return { rows: [{ is_future: true }] };
      return { rows: [] };
    });

    const res = await request(app)
      .patch(`/api/v1/pieces-techniques/${pieceId}/versions/${versionId}/status`)
      .send({ next_statut: "APPLICABLE" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "VERSION_EFFECTIVE_DATE_FUTURE" });
    expect(mocks.clientQuery.mock.calls.some((call) => String(call[0]).includes("SET statut = 'OBSOLETE'"))).toBe(false);
  });

  it("rejects a manufactured child relation that would create a fabrication cycle", async () => {
    const parentId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";

    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const q = String(sql);
      if (q === "BEGIN" || q === "ROLLBACK") return { rows: [] };
      if (q.includes("SELECT 1::int AS ok FROM pieces_techniques")) return { rows: [{ ok: 1 }] };
      if (q.includes("WITH RECURSIVE descendants")) return { rows: [{ found: 1 }] };
      return { rows: [] };
    });

    const res = await request(app)
      .post(`/api/v1/pieces-techniques/${parentId}/nomenclature`)
      .send({ child_piece_id: childId, quantite: 1 });

    expect(res.status).toBe(409);
    expect(mocks.clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(
      mocks.clientQuery.mock.calls.some((call) => String(call[0]).includes("INSERT INTO pieces_techniques_nomenclature"))
    ).toBe(false);
  });
});
