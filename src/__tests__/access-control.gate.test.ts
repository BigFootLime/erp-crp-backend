/**
 * #326 / back #200 — gate d'accès module monté globalement dans v1.routes.ts.
 * Le frontend masque, le backend refuse : ce fichier éprouve le refus réel, le
 * passage du superadmin, l'immunité du module protégé, le fail-open documenté sur
 * absence d'infrastructure (42P01) et le kill-switch d'exploitation.
 */
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = { on: emitter.on.bind(emitter), query: mocks.poolQuery, connect: mocks.poolConnect };
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/auth/middlewares/auth.middleware")>();
  return {
    ...actual,
    authenticateToken: (
      req: { user?: unknown; headers: Record<string, unknown> },
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void
    ) => {
      const role = typeof req.headers["x-test-role"] === "string" ? (req.headers["x-test-role"] as string) : "";
      if (!role) {
        res.status(401).json({ error: "Token manquant ou invalide" });
        return;
      }
      req.user = { id: 9, username: "t", email: "t@t.t", role };
      next();
    },
  };
});

// Seule la lecture du profil est simulée : la règle de décision, le cache et le
// middleware restent les vrais.
vi.mock("../module/access-control/repository/access-control.repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../module/access-control/repository/access-control.repository")>();
  return { ...actual, repoResolveAccessProfile: vi.fn() };
});

import type { NextFunction, Request, Response } from "express";

import app from "../config/app";
import * as baseRepo from "../module/access-control/repository/access-control.repository";
import { moduleAccessGate } from "../module/access-control/middlewares/module-access-gate";
import { invalidateAccessCache } from "../module/access-control/services/access-control.service";

const repo = vi.mocked(baseRepo);
const USER_ID = 9;

type FakeRes = Response & { statusCode: number; body: unknown };

function fakeRes(): FakeRes {
  const res = { statusCode: 0, body: null as unknown } as unknown as FakeRes;
  (res as unknown as { status: (n: number) => unknown }).status = (n: number) => {
    res.statusCode = n;
    return res;
  };
  (res as unknown as { json: (b: unknown) => unknown }).json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
}

// `null` signifie explicitement « aucun utilisateur attaché », ce qu'un paramètre
// optionnel ne permettrait pas de distinguer de l'absence d'argument.
function fakeReq(path: string, user: { id: number } | null): Request {
  return {
    path,
    originalUrl: `/api/v1${path}`,
    method: "GET",
    headers: {},
    user: user ?? undefined,
  } as unknown as Request;
}

function profileRow(overrides: {
  module_key: string;
  access?: "GRANTED" | "DENIED" | null;
  enabled_by_default?: boolean;
  is_active?: boolean;
  is_superadmin?: boolean;
}) {
  return {
    is_superadmin: overrides.is_superadmin ?? false,
    module_key: overrides.module_key,
    label: overrides.module_key,
    nav_page_keys: [],
    enabled_by_default: overrides.enabled_by_default ?? true,
    is_protected: false,
    is_active: overrides.is_active ?? true,
    access: overrides.access ?? null,
  };
}

async function run(path: string, user: { id: number } | null = { id: USER_ID }) {
  const res = fakeRes();
  const next = vi.fn() as unknown as NextFunction;
  moduleAccessGate(fakeReq(path, user), res, next);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { res, next: next as unknown as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAccessCache();
  delete process.env.CERP_MODULE_ACCESS_GATE_DISABLED;

  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  repo.repoResolveAccessProfile.mockResolvedValue([profileRow({ module_key: "clients" })]);
});

afterEach(() => {
  delete process.env.CERP_MODULE_ACCESS_GATE_DISABLED;
});

describe("Gate d'accès module — passages sans interrogation de la base", () => {
  it("laisse passer une surface d'infrastructure partagée sans résoudre aucun profil", async () => {
    const { next } = await run("/users/4");
    expect(next).toHaveBeenCalledOnce();
    expect(repo.repoResolveAccessProfile).not.toHaveBeenCalled();
  });

  it("laisse passer le module protégé sans résoudre aucun profil", async () => {
    const { res, next } = await run("/admin/users");
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
    expect(repo.repoResolveAccessProfile).not.toHaveBeenCalled();
  });

  it("laisse passer quand aucun utilisateur n'est attaché à la requête", async () => {
    const { next } = await run("/clients/1", null);
    expect(next).toHaveBeenCalledOnce();
    expect(repo.repoResolveAccessProfile).not.toHaveBeenCalled();
  });

  it("kill-switch d'exploitation : le gate s'efface immédiatement", async () => {
    process.env.CERP_MODULE_ACCESS_GATE_DISABLED = "1";
    repo.repoResolveAccessProfile.mockResolvedValue([
      profileRow({ module_key: "clients", access: "DENIED" }),
    ]);
    const { res, next } = await run("/clients/1");
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
    expect(repo.repoResolveAccessProfile).not.toHaveBeenCalled();
  });
});

describe("Gate d'accès module — décisions", () => {
  it("refus explicite ⇒ 403 sobre, sans jamais atteindre la route", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue([
      profileRow({ module_key: "clients", access: "DENIED" }),
    ]);
    const { res, next } = await run("/clients/1");

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Accès interdit" });
    expect(JSON.stringify(res.body)).not.toMatch(/module|superadmin|catalogue|interdit au module/i);
  });

  it("défaut catalogue désactivé ⇒ 403 sans override", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue([
      profileRow({ module_key: "clients", enabled_by_default: false }),
    ]);
    const { res } = await run("/clients/1");
    expect(res.statusCode).toBe(403);
  });

  it("module désactivé au catalogue ⇒ 403", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue([
      profileRow({ module_key: "clients", is_active: false }),
    ]);
    const { res } = await run("/clients/1");
    expect(res.statusCode).toBe(403);
  });

  it("le superadmin traverse tout, même un module explicitement refusé", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue([
      profileRow({ module_key: "clients", access: "DENIED", is_superadmin: true }),
    ]);
    const { res, next } = await run("/clients/1");
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it("le refus d'un module n'en refuse aucun autre", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue([
      profileRow({ module_key: "clients", access: "DENIED" }),
      profileRow({ module_key: "stock" }),
    ]);
    expect((await run("/clients/1")).res.statusCode).toBe(403);
    expect((await run("/stock/articles")).next).toHaveBeenCalledOnce();
  });

  it("« /production/station » est bien filtré par le module production", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue([
      profileRow({ module_key: "production", access: "DENIED" }),
    ]);
    const { res } = await run("/production/station/sessions");
    expect(res.statusCode).toBe(403);
  });

  it("résout le profil une seule fois par compte grâce au cache", async () => {
    await run("/clients/1");
    await run("/clients/2");
    expect(repo.repoResolveAccessProfile).toHaveBeenCalledTimes(1);
  });
});

describe("Gate d'accès module — absence d'infrastructure", () => {
  it("tables absentes (42P01) ⇒ fail-open documenté, jamais un ERP briqué", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue(null);
    const { res, next } = await run("/clients/1");
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it("module absent du catalogue en base ⇒ fail-open, aucun refus fabriqué", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue([profileRow({ module_key: "stock" })]);
    const { res, next } = await run("/clients/1");
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it("erreur de base non liée à l'infrastructure ⇒ remontée à la chaîne d'erreurs", async () => {
    const failure = new Error("connexion perdue");
    repo.repoResolveAccessProfile.mockRejectedValue(failure);
    const { res, next } = await run("/clients/1");
    expect(res.statusCode).toBe(0);
    expect(next).toHaveBeenCalledWith(failure);
  });
});

describe("Gate d'accès module — application réelle", () => {
  it("refuse 403 sur une route métier réelle, sans fuiter le motif", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue([
      profileRow({ module_key: "clients", access: "DENIED" }),
    ]);

    const res = await request(app).get("/api/v1/clients").set("x-test-role", "Directeur");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Accès interdit" });
    expect(JSON.stringify(res.body)).not.toMatch(/module|superadmin|catalogue/i);
  });

  it("n'ôte aucun garde existant : sans jeton, c'est toujours 401 avant le gate", async () => {
    const res = await request(app).get("/api/v1/clients");
    expect(res.status).toBe(401);
    expect(repo.repoResolveAccessProfile).not.toHaveBeenCalled();
  });
});
