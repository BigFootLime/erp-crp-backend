import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/project-office/repository/project-office.repository", async (io) => {
  const actual = await io<typeof import("../module/project-office/repository/project-office.repository")>();
  return {
    ...actual,
    repoResolveFeatureAccess: vi.fn(),
    repoGetProjectAccess: vi.fn(),
  };
});

import type { NextFunction, Request, Response } from "express";
import * as baseRepo from "../module/project-office/repository/project-office.repository";
import { buildAuditContext } from "../module/project-office/controllers/project-office.controller";
import { requireProjectOfficeAccess } from "../module/project-office/middlewares/require-project-office-access";
import {
  assertProjectOfficeAccess,
  hasProjectOfficeAccess,
  requireProjectAccess,
} from "../module/project-office/services/project-office-access.service";

const repo = vi.mocked(baseRepo);
const PILOTE = { id: 42, role: "Directeur" };
const AUTRE = { id: 7, role: "Employee" };
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function fakeRes() {
  const res = { statusCode: 0, body: null as unknown } as unknown as Response & { statusCode: number; body: unknown };
  (res as unknown as { status: (n: number) => unknown }).status = (n: number) => { res.statusCode = n; return res; };
  (res as unknown as { json: (b: unknown) => unknown }).json = (b: unknown) => { res.body = b; return res; };
  return res;
}

beforeEach(() => vi.clearAllMocks());

describe("Feature gate PROJECT_OFFICE — fail-closed", () => {
  it("pilote avec override user → accès true", async () => {
    repo.repoResolveFeatureAccess.mockResolvedValue(true);
    expect(await hasProjectOfficeAccess(PILOTE.id)).toBe(true);
  });
  it("utilisateur sans override, flag global OFF → accès false", async () => {
    repo.repoResolveFeatureAccess.mockResolvedValue(false);
    expect(await hasProjectOfficeAccess(AUTRE.id)).toBe(false);
  });
  it("assertProjectOfficeAccess → 403 PO_FORBIDDEN non bavard", async () => {
    repo.repoResolveFeatureAccess.mockResolvedValue(false);
    await expect(assertProjectOfficeAccess(AUTRE.id)).rejects.toMatchObject({ status: 403, code: "PO_FORBIDDEN" });
  });
});

describe("Middleware requireProjectOfficeAccess", () => {
  it("non authentifié → 401 (jamais next)", async () => {
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    requireProjectOfficeAccess({ user: undefined, headers: {} } as unknown as Request, res, next);
    await new Promise((r) => setTimeout(r, 0));
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it("authentifié non autorisé → 403 contrôlé (pas de détail)", async () => {
    repo.repoResolveFeatureAccess.mockResolvedValue(false);
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    requireProjectOfficeAccess({ user: { id: AUTRE.id, role: "Employee" }, headers: {}, method: "GET", originalUrl: "/x" } as unknown as Request, res, next);
    await new Promise((r) => setTimeout(r, 0));
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/flag|feature|pilote/i);
    expect(next).not.toHaveBeenCalled();
  });
  it("pilote autorisé → next()", async () => {
    repo.repoResolveFeatureAccess.mockResolvedValue(true);
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    requireProjectOfficeAccess({ user: { id: PILOTE.id, role: "Directeur" }, headers: {} } as unknown as Request, res, next);
    await new Promise((r) => setTimeout(r, 0));
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });
});

describe("Contexte d'audit Project Office", () => {
  it("utilise req.ip résolu par Express plutôt que le premier X-Forwarded-For", () => {
    const req = {
      user: { id: PILOTE.id, role: PILOTE.role },
      ip: "203.0.113.42",
      headers: {
        "x-forwarded-for": "198.51.100.99, 203.0.113.42",
        "user-agent": "Mozilla/5.0",
      },
      originalUrl: "/api/v1/project-office/projects",
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request;

    expect(buildAuditContext(req).ip).toBe("203.0.113.42");
  });
});

describe("Anti-IDOR projet (requireProjectAccess)", () => {
  it("projet invisible (PRIVATE non membre) → 404 contrôlé, pas 403 (pas de fuite d'existence)", async () => {
    repo.repoGetProjectAccess.mockResolvedValue(null);
    await expect(requireProjectAccess(AUTRE, PROJECT_ID, "read")).rejects.toMatchObject({ status: 404, code: "PO_PROJECT_NOT_FOUND" });
  });
  it("VIEWER (INTERNAL) peut lire mais PAS écrire → 403", async () => {
    repo.repoGetProjectAccess.mockResolvedValue({ project_id: PROJECT_ID, visibility: "INTERNAL", owner_id: 1, effective_role: "VIEWER" });
    await expect(requireProjectAccess(AUTRE, PROJECT_ID, "read")).resolves.toMatchObject({ effective_role: "VIEWER" });
    await expect(requireProjectAccess(AUTRE, PROJECT_ID, "write")).rejects.toMatchObject({ status: 403, code: "PO_PROJECT_READ_ONLY" });
  });
  it("CONTRIBUTOR écrit mais ne gère pas les membres → 403 manage", async () => {
    repo.repoGetProjectAccess.mockResolvedValue({ project_id: PROJECT_ID, visibility: "PRIVATE", owner_id: 1, effective_role: "CONTRIBUTOR" });
    await expect(requireProjectAccess(AUTRE, PROJECT_ID, "write")).resolves.toBeTruthy();
    await expect(requireProjectAccess(AUTRE, PROJECT_ID, "manage")).rejects.toMatchObject({ status: 403, code: "PO_PROJECT_NOT_MANAGER" });
  });
  it("OWNER a tous les droits", async () => {
    repo.repoGetProjectAccess.mockResolvedValue({ project_id: PROJECT_ID, visibility: "PRIVATE", owner_id: PILOTE.id, effective_role: "OWNER" });
    await expect(requireProjectAccess(PILOTE, PROJECT_ID, "manage")).resolves.toMatchObject({ effective_role: "OWNER" });
  });
});
