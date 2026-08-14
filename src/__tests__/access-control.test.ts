/**
 * #326 / back #200 — socle serveur de la tour de contrôle des accès.
 *  1. Résolution chemin -> module : plus long préfixe, frontière de segment,
 *     surfaces d'infrastructure jamais rattachées à un module.
 *  2. Règles métier : module protégé jamais restreignable, compte superadmin
 *     jamais restreignable, INHERIT = suppression de la ligne d'override.
 *  3. Audit : la ligne erp_audit_logs est écrite dans la MÊME transaction.
 *  4. Surface /admin/access : réservée au superadmin, 403 non bavard.
 *  5. `is_superadmin` est exposé en lecture seule et rejeté en écriture.
 */
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  txQuery: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = { on: emitter.on.bind(emitter), query: mocks.poolQuery, connect: mocks.poolConnect };
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

// authenticateToken simulé (401 sans en-tête de test) ; requireSuperadmin et
// authorizeRole RÉELS — ce sont précisément les gardes que l'on veut éprouver.
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
      const rawId = req.headers["x-test-user-id"];
      const id = typeof rawId === "string" ? Number(rawId) : 1;
      req.user = { id, username: "t", email: "t@t.t", role };
      next();
    },
  };
});

// Le dépôt est simulé pour éprouver les RÈGLES sans dépendre d'un dialecte SQL ;
// `withTransaction` fournit une transaction factice observable.
vi.mock("../module/access-control/repository/access-control.repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../module/access-control/repository/access-control.repository")>();
  return {
    ...actual,
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: mocks.txQuery })
    ),
    repoAuthorizationEpoch: vi.fn(),
    repoResolveAccessProfile: vi.fn(),
    repoIsSuperadmin: vi.fn(),
    repoListCatalogModules: vi.fn(),
    repoGetCatalogModule: vi.fn(),
    repoListAccessUsers: vi.fn(),
    repoGetAccessUser: vi.fn(),
    repoListAccessOverrides: vi.fn(),
    repoGetUserModuleAccess: vi.fn(),
    repoSetModuleDefault: vi.fn(),
    repoUpsertUserModuleAccess: vi.fn(),
    repoDeleteUserModuleAccess: vi.fn(),
    repoDeleteAllDenials: vi.fn(),
    repoRestoreAllDefaults: vi.fn(),
    repoInsertAccessEvent: vi.fn(),
    repoListAccessEvents: vi.fn(),
  };
});

import app from "../config/app";
import * as baseRepo from "../module/access-control/repository/access-control.repository";
import {
  MODULE_CATALOG,
  PROTECTED_MODULE_KEYS,
  resolveModuleKeyForPath,
} from "../module/access-control/domain/module-catalog";
import * as service from "../module/access-control/services/access-control.service";
import { withRealtimeOutboxDbMock } from "./helpers/realtime-outbox-db-mock";

const repo = vi.mocked(baseRepo);

const SUPERADMIN_ID = 4;
const OPERATEUR_ID = 9;

const CATALOG_ROW = {
  module_key: "clients",
  label: "Clients",
  description: null,
  category: "Commerce",
  api_prefixes: ["/clients"],
  nav_page_keys: ["clients"],
  enabled_by_default: true,
  is_protected: false,
  sort_order: 10,
  is_active: true,
};

const PROTECTED_ROW = { ...CATALOG_ROW, module_key: "administration", label: "Administration", is_protected: true };

const USER_ROW = {
  id: OPERATEUR_ID,
  username: "OPERATEUR",
  name: "N",
  surname: "P",
  email: "op@croix-rousse-precision.fr",
  role: "Employee",
  roles: ["Employee"],
  status: "Active",
  is_superadmin: false,
  last_login: null,
};

const SUPERADMIN_ROW = { ...USER_ROW, id: SUPERADMIN_ID, username: "KEENAN", is_superadmin: true };

const AUDIT = {
  user_id: SUPERADMIN_ID,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: "/api/v1/admin/access",
  client_session_id: null,
};

function txSql(): string[] {
  return mocks.txQuery.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  service.invalidateAccessCache();

  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.txQuery.mockImplementation(withRealtimeOutboxDbMock(async () => {
    return { rows: [{ id: "audit-1", created_at: "2026-07-27T00:00:00Z" }] };
  }));

  repo.repoIsSuperadmin.mockResolvedValue(false);
  repo.repoAuthorizationEpoch.mockResolvedValue(1n);
  repo.repoListCatalogModules.mockResolvedValue([CATALOG_ROW, PROTECTED_ROW]);
  repo.repoListAccessUsers.mockResolvedValue([USER_ROW, SUPERADMIN_ROW]);
  repo.repoListAccessOverrides.mockResolvedValue([]);
  repo.repoGetCatalogModule.mockResolvedValue(CATALOG_ROW);
  repo.repoGetAccessUser.mockResolvedValue(USER_ROW);
  repo.repoGetUserModuleAccess.mockResolvedValue(null);
  repo.repoDeleteAllDenials.mockResolvedValue([]);
  repo.repoRestoreAllDefaults.mockResolvedValue([]);
});

describe("Catalogue de modules #326", () => {
  it("expose 24 modules aux clés et préfixes uniques, dont un seul protégé", () => {
    expect(MODULE_CATALOG).toHaveLength(24);
    const keys = MODULE_CATALOG.map((entry) => entry.module_key);
    expect(new Set(keys).size).toBe(24);

    const prefixes = MODULE_CATALOG.flatMap((entry) => entry.api_prefixes);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes.every((prefix) => prefix.startsWith("/"))).toBe(true);
    expect(PROTECTED_MODULE_KEYS).toEqual(["administration"]);
  });

  it("résout le module par le plus long préfixe, sur une frontière de segment", () => {
    expect(resolveModuleKeyForPath("/production/station/of/42")).toBe("production");
    expect(resolveModuleKeyForPath("/production")).toBe("production");
    expect(resolveModuleKeyForPath("/clients/123/contacts")).toBe("clients");
    // « /commandes » ne doit jamais capter « /commandes-fournisseurs ».
    expect(resolveModuleKeyForPath("/commandes/17")).toBe("commandes-clients");
    expect(resolveModuleKeyForPath("/commandes-fournisseurs/17")).toBe("commandes-fournisseurs");
    expect(resolveModuleKeyForPath("/replenishment-proposals/17/validate")).toBe("commandes-fournisseurs");
    expect(resolveModuleKeyForPath("/piece-technique-versions/9")).toBe("pieces-techniques");
    expect(resolveModuleKeyForPath("/pieces-techniques/9")).toBe("pieces-techniques");
    expect(resolveModuleKeyForPath("/finitions/9")).toBe("finitions");
    expect(resolveModuleKeyForPath("/methodes/centres-frais/9")).toBe("methodes-centres-frais");
    expect(resolveModuleKeyForPath("/methodes/machines/9")).toBe("methodes-parc-machines");
    expect(resolveModuleKeyForPath("/methodes/familles-machine/9")).toBe("methodes-parc-machines");
    expect(resolveModuleKeyForPath("/centre-frais/9")).toBe("methodes-centres-frais");
    expect(resolveModuleKeyForPath("/ged/documents")).toBe("ged");
  });

  it("rend les nouveaux espaces sélectionnables séparément dans la tour d'accès", () => {
    const technicalData = MODULE_CATALOG.find((entry) => entry.module_key === "pieces-techniques");
    const finitions = MODULE_CATALOG.find((entry) => entry.module_key === "finitions");
    const costCenters = MODULE_CATALOG.find((entry) => entry.module_key === "methodes-centres-frais");
    const machines = MODULE_CATALOG.find((entry) => entry.module_key === "methodes-parc-machines");
    const stock = MODULE_CATALOG.find((entry) => entry.module_key === "stock");
    const ged = MODULE_CATALOG.find((entry) => entry.module_key === "ged");

    expect(technicalData?.nav_page_keys).toEqual(["pieces-techniques"]);
    expect(finitions).toMatchObject({ nav_page_keys: ["finitions"], api_prefixes: ["/finitions"] });
    expect(costCenters).toMatchObject({ nav_page_keys: ["methodes-centres-frais"] });
    expect(machines).toMatchObject({ nav_page_keys: ["methodes-parc-machines"] });
    expect(stock?.nav_page_keys).toEqual(expect.arrayContaining(["stock-base-old", "stock-base-new"]));
    expect(ged).toMatchObject({
      is_protected: false,
      api_prefixes: ["/ged"],
      nav_page_keys: ["ged"],
    });
  });

  it("accepte une URL complète et ignore la query string", () => {
    expect(resolveModuleKeyForPath("/api/v1/qualite/v2/plans?limit=10")).toBe("qualite");
    expect(resolveModuleKeyForPath("/api/v1/admin/access/overview")).toBe("administration");
    expect(resolveModuleKeyForPath("/stock/")).toBe("stock");
  });

  it("rattache les journaux à Administration et laisse les autres surfaces partagées hors catalogue", () => {
    expect(resolveModuleKeyForPath("/audit-logs")).toBe("administration");
    for (const path of [
      "/auth/login",
      "/codes/formats",
      "/notifications",
      "/chat/threads",
      "/users/4",
      "/locks",
      "/pieces-families",
      "/environment",
    ]) {
      expect(resolveModuleKeyForPath(path)).toBeNull();
    }
    expect(resolveModuleKeyForPath("")).toBeNull();
    expect(resolveModuleKeyForPath(undefined)).toBeNull();
  });
});

describe("Règles métier de la tour de contrôle", () => {
  it("refuse tout défaut global fermé et protège le module administration", async () => {
    repo.repoGetCatalogModule.mockResolvedValue(PROTECTED_ROW);

    await expect(
      service.setModuleDefault({ moduleKey: "administration", enabled: false, audit: AUDIT })
    ).rejects.toMatchObject({ status: 409, code: "ACCOUNT_ONLY_ACCESS_POLICY" });

    await expect(
      service.setUserModuleAccess({
        userId: OPERATEUR_ID,
        moduleKey: "administration",
        decision: "DENIED",
        audit: AUDIT,
      })
    ).rejects.toMatchObject({ status: 409, code: "MODULE_PROTECTED" });

    expect(repo.repoUpsertUserModuleAccess).not.toHaveBeenCalled();
    expect(repo.repoSetModuleDefault).not.toHaveBeenCalled();
  });

  it("normalise un ancien GRANTED explicite en ouverture par défaut", async () => {
    repo.repoGetCatalogModule.mockResolvedValue(PROTECTED_ROW);
    await service.setUserModuleAccess({
      userId: OPERATEUR_ID,
      moduleKey: "administration",
      decision: "GRANTED",
      audit: AUDIT,
    });
    expect(repo.repoUpsertUserModuleAccess).not.toHaveBeenCalled();
  });

  it("refuse 409 SUPERADMIN_IMMUTABLE de refuser un module à un superadmin", async () => {
    repo.repoGetAccessUser.mockResolvedValue(SUPERADMIN_ROW);
    await expect(
      service.setUserModuleAccess({
        userId: SUPERADMIN_ID,
        moduleKey: "clients",
        decision: "DENIED",
        audit: AUDIT,
      })
    ).rejects.toMatchObject({ status: 409, code: "SUPERADMIN_IMMUTABLE" });
    expect(repo.repoUpsertUserModuleAccess).not.toHaveBeenCalled();
  });

  it("INHERIT supprime la ligne d'override et journalise INHERITED", async () => {
    repo.repoGetUserModuleAccess.mockResolvedValue("DENIED");

    await service.setUserModuleAccess({
      userId: OPERATEUR_ID,
      moduleKey: "clients",
      decision: "INHERIT",
      audit: AUDIT,
    });

    expect(repo.repoDeleteUserModuleAccess).toHaveBeenCalledWith(expect.anything(), {
      userId: OPERATEUR_ID,
      moduleKey: "clients",
    });
    expect(repo.repoUpsertUserModuleAccess).not.toHaveBeenCalled();
    expect(repo.repoInsertAccessEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "INHERITED", previousState: "DENIED", nextState: "INHERIT" })
    );
  });

  it("n'écrit rien quand la décision demandée est déjà l'état courant", async () => {
    repo.repoGetUserModuleAccess.mockResolvedValue("DENIED");
    await service.setUserModuleAccess({
      userId: OPERATEUR_ID,
      moduleKey: "clients",
      decision: "DENIED",
      audit: AUDIT,
    });
    expect(repo.repoUpsertUserModuleAccess).not.toHaveBeenCalled();
    expect(repo.repoInsertAccessEvent).not.toHaveBeenCalled();
    expect(txSql().join(" ")).not.toContain("erp_audit_logs");
  });

  it("écrit l'audit ERP dans la MÊME transaction que la mutation", async () => {
    await service.setUserModuleAccess({
      userId: OPERATEUR_ID,
      moduleKey: "clients",
      decision: "DENIED",
      audit: AUDIT,
    });

    const auditInsert = mocks.txQuery.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO erp_audit_logs")
    );
    expect(auditInsert).toBeDefined();
    const values = auditInsert?.[1] as unknown[];
    expect(values).toContain("ACCESS_USER_MODULE_SET");
    expect(values).toContain("administration-acces");
    expect(values).toContain("module_access");
    expect(values).toContain(`${OPERATEUR_ID}:clients`);
  });

  it("le bulk applique chaque décision et journalise un seul ACCESS_USER_BULK_SET", async () => {
    repo.repoGetCatalogModule.mockImplementation(async (moduleKey: string) =>
      moduleKey === "administration" ? PROTECTED_ROW : { ...CATALOG_ROW, module_key: moduleKey }
    );

    await service.setUserModulesBulk({
      userId: OPERATEUR_ID,
      entries: [
        { module_key: "clients", access: "DENIED" },
        { module_key: "stock", access: "GRANTED" },
      ],
      audit: AUDIT,
    });

    expect(repo.repoUpsertUserModuleAccess).toHaveBeenCalledTimes(1);
    const auditActions = mocks.txQuery.mock.calls
      .filter((call) => String(call[0]).includes("INSERT INTO erp_audit_logs"))
      .map((call) => (call[1] as unknown[])[2]);
    expect(auditActions).toEqual(["ACCESS_USER_BULK_SET"]);
  });

  it("« tout débloquer » exige la confirmation exacte", async () => {
    await expect(service.unlockAll({ confirm: "debloquer tout", audit: AUDIT })).rejects.toMatchObject({
      status: 400,
      code: "CONFIRMATION_REQUIRED",
    });
    expect(repo.repoDeleteAllDenials).not.toHaveBeenCalled();

    repo.repoDeleteAllDenials.mockResolvedValue([{ user_id: OPERATEUR_ID, module_key: "clients" }]);
    repo.repoRestoreAllDefaults.mockResolvedValue(["stock"]);
    await service.unlockAll({ confirm: "DEBLOQUER TOUT", audit: AUDIT });

    expect(repo.repoDeleteAllDenials).toHaveBeenCalledOnce();
    expect(repo.repoRestoreAllDefaults).toHaveBeenCalledOnce();
    expect(repo.repoInsertAccessEvent).toHaveBeenCalledTimes(2);
  });

  it("404 explicite sur un module ou un compte inconnu", async () => {
    repo.repoGetCatalogModule.mockResolvedValue(null);
    await expect(
      service.setModuleDefault({ moduleKey: "inconnu", enabled: true, audit: AUDIT })
    ).rejects.toMatchObject({ status: 404, code: "MODULE_NOT_FOUND" });

    repo.repoGetAccessUser.mockResolvedValue(null);
    await expect(
      service.setUserModuleAccess({ userId: 999, moduleKey: "clients", decision: "DENIED", audit: AUDIT })
    ).rejects.toMatchObject({ status: 404, code: "USER_NOT_FOUND" });
  });
});

describe("Résolution du profil d'accès", () => {
  const profileRows = (overrides: Partial<{ access: "GRANTED" | "DENIED"; enabled: boolean; superadmin: boolean }>) => [
    {
      is_superadmin: overrides.superadmin ?? false,
      module_key: "clients",
      label: "Clients",
      nav_page_keys: ["clients"],
      enabled_by_default: overrides.enabled ?? true,
      is_protected: false,
      is_active: true,
      access: overrides.access ?? null,
    },
  ];

  it("reste ouvert même si une ancienne valeur catalogue vaut false", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue(profileRows({ enabled: false }));
    const profile = await service.getAccessProfile(OPERATEUR_ID);
    expect(profile.modules[0]).toMatchObject({ allowed: true, source: "DEFAULT" });
  });

  it("l'override explicite prime sur le défaut catalogue", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue(profileRows({ enabled: false, access: "GRANTED" }));
    const profile = await service.getAccessProfile(OPERATEUR_ID);
    expect(profile.modules[0]).toMatchObject({ allowed: true, source: "OVERRIDE" });
  });

  it("le superadmin traverse tout, même un module refusé explicitement", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue(
      profileRows({ enabled: false, access: "DENIED", superadmin: true })
    );
    const profile = await service.getAccessProfile(SUPERADMIN_ID);
    expect(profile.is_superadmin).toBe(true);
    expect(profile.modules[0]).toMatchObject({ allowed: true, source: "SUPERADMIN" });
  });

  it("infrastructure absente (42P01) : profil vide en 200, jamais un refus", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue(null);
    expect(await service.getAccessProfile(OPERATEUR_ID)).toEqual({
      contract_version: 1,
      cache_ttl_seconds: 10,
      is_superadmin: false,
      modules: [],
    });
  });

  it("met le profil en cache et le relit après invalidation explicite", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue(profileRows({}));
    await service.getAccessProfile(OPERATEUR_ID);
    await service.getAccessProfile(OPERATEUR_ID);
    expect(repo.repoResolveAccessProfile).toHaveBeenCalledTimes(1);

    service.invalidateAccessCache(OPERATEUR_ID);
    await service.getAccessProfile(OPERATEUR_ID);
    expect(repo.repoResolveAccessProfile).toHaveBeenCalledTimes(2);
  });

  it("relit le profil quand l'epoch partage change meme si la notification locale est perdue", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue(profileRows({}));
    await service.getAccessProfile(OPERATEUR_ID);
    await service.getAccessProfile(OPERATEUR_ID);
    expect(repo.repoResolveAccessProfile).toHaveBeenCalledTimes(1);

    repo.repoAuthorizationEpoch.mockResolvedValue(2n);
    repo.repoResolveAccessProfile.mockResolvedValue(profileRows({ access: "DENIED" }));
    const refreshed = await service.getAccessProfile(OPERATEUR_ID);

    expect(repo.repoResolveAccessProfile).toHaveBeenCalledTimes(2);
    expect(refreshed.modules[0]).toMatchObject({ allowed: false, source: "OVERRIDE" });
  });

  it("une mutation invalide le cache du compte visé", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue(profileRows({}));
    await service.getAccessProfile(OPERATEUR_ID);
    await service.setUserModuleAccess({
      userId: OPERATEUR_ID,
      moduleKey: "clients",
      decision: "DENIED",
      audit: AUDIT,
    });
    await service.getAccessProfile(OPERATEUR_ID);
    expect(repo.repoResolveAccessProfile).toHaveBeenCalledTimes(2);
  });
});

describe("Vue d'ensemble /admin/access/overview", () => {
  it("assemble catalogue, comptes, matrice tri-état et compteurs", async () => {
    repo.repoListAccessOverrides.mockResolvedValue([
      { user_id: OPERATEUR_ID, module_key: "clients", access: "DENIED" },
    ]);

    const overview = await service.buildOverview();

    expect(overview.summary).toMatchObject({
      users_total: 2,
      superadmins: 1,
      modules_total: 2,
      modules_restricted_by_default: 0,
      active_restrictions: 1,
    });
    expect(overview.modules.find((m) => m.module_key === "clients")?.denied_count).toBe(1);

    const cell = overview.matrix.find(
      (entry) => entry.user_id === OPERATEUR_ID && entry.module_key === "clients"
    );
    expect(cell).toMatchObject({ access: "DENIED", effective: false, source: "OVERRIDE" });

    // Hérité : la cellule ne porte AUCUN override, mais reste effectivement lisible.
    const inherited = overview.matrix.find(
      (entry) => entry.user_id === OPERATEUR_ID && entry.module_key === "administration"
    );
    expect(inherited).toMatchObject({ access: null, effective: true, source: "DEFAULT" });

    // Le superadmin traverse tout, y compris le module refusé au reste.
    const superadminCell = overview.matrix.find(
      (entry) => entry.user_id === SUPERADMIN_ID && entry.module_key === "clients"
    );
    expect(superadminCell).toMatchObject({ effective: true, source: "SUPERADMIN" });
    expect(overview.users.find((u) => u.id === OPERATEUR_ID)).toMatchObject({
      denied_count: 1,
      allowed_count: 1,
    });
  });
});

describe("Surface HTTP /admin/access", () => {
  it("401 sans authentification", async () => {
    const res = await request(app).get("/api/v1/admin/access/overview");
    expect(res.status).toBe(401);
  });

  it("403 non bavard pour un compte non superadmin, même Directeur", async () => {
    repo.repoIsSuperadmin.mockResolvedValue(false);
    const res = await request(app)
      .get("/api/v1/admin/access/overview")
      .set("x-test-role", "Directeur")
      .set("x-test-user-id", String(OPERATEUR_ID));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/module|superadmin|catalog|acc[eè]s aux modules/i);
    expect(res.body).toEqual({ error: "Accès interdit" });
  });

  it("refuse aussi la création d'une revue d'accès à un Directeur non superadmin", async () => {
    repo.repoIsSuperadmin.mockResolvedValue(false);
    const res = await request(app)
      .post("/api/v1/admin/access/reviews")
      .set("x-test-role", "Directeur")
      .set("x-test-user-id", String(OPERATEUR_ID))
      .set("Idempotency-Key", "review-rbac-negative")
      .send({
        inactivity_days: 90,
        login_failure_window_days: 30,
        failed_login_threshold: 5,
        due_in_days: 14,
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Accès interdit" });
  });

  it("403 fail-closed quand la résolution du statut superadmin échoue", async () => {
    repo.repoIsSuperadmin.mockRejectedValue(new Error("connexion perdue"));
    const res = await request(app)
      .get("/api/v1/admin/access/overview")
      .set("x-test-role", "Directeur")
      .set("x-test-user-id", String(SUPERADMIN_ID));
    expect(res.status).toBe(403);
  });

  it("200 pour le superadmin, avec l'enveloppe complète du contrat", async () => {
    repo.repoIsSuperadmin.mockResolvedValue(true);
    const res = await request(app)
      .get("/api/v1/admin/access/overview")
      .set("x-test-role", "Employee")
      .set("x-test-user-id", String(SUPERADMIN_ID));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["matrix", "modules", "summary", "users"]);
  });

  it("409 ACCOUNT_ONLY_ACCESS_POLICY via l'API pour toute fermeture globale", async () => {
    repo.repoIsSuperadmin.mockResolvedValue(true);
    repo.repoGetCatalogModule.mockResolvedValue(PROTECTED_ROW);
    const res = await request(app)
      .put("/api/v1/admin/access/modules/administration/default")
      .set("x-test-role", "Employee")
      .set("x-test-user-id", String(SUPERADMIN_ID))
      .send({ enabled_by_default: false });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "ACCOUNT_ONLY_ACCESS_POLICY" });
  });

  it("400 CONFIRMATION_REQUIRED sur « tout débloquer » sans la phrase exacte", async () => {
    repo.repoIsSuperadmin.mockResolvedValue(true);
    const res = await request(app)
      .post("/api/v1/admin/access/unlock-all")
      .set("x-test-role", "Employee")
      .set("x-test-user-id", String(SUPERADMIN_ID))
      .send({ confirm: "oui" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  });

  it("rejette une décision d'accès hors GRANTED/DENIED/INHERIT", async () => {
    repo.repoIsSuperadmin.mockResolvedValue(true);
    const res = await request(app)
      .put(`/api/v1/admin/access/users/${OPERATEUR_ID}/modules/clients`)
      .set("x-test-role", "Employee")
      .set("x-test-user-id", String(SUPERADMIN_ID))
      .send({ access: "PEUT-ETRE" });

    expect(res.status).toBe(400);
    expect(repo.repoUpsertUserModuleAccess).not.toHaveBeenCalled();
  });
});

describe("Profil d'accès et exposition du marqueur superadmin", () => {
  it("GET /auth/access-profile refuse 401 sans authentification", async () => {
    const res = await request(app).get("/api/v1/auth/access-profile");

    expect(res.status).toBe(401);
    expect(repo.repoResolveAccessProfile).not.toHaveBeenCalled();
  });

  it("GET /auth/access-profile est ouvert à tout compte authentifié", async () => {
    repo.repoResolveAccessProfile.mockResolvedValue([
      {
        is_superadmin: false,
        module_key: "clients",
        label: "Clients",
        nav_page_keys: ["clients"],
        enabled_by_default: true,
        is_protected: false,
        is_active: true,
        access: null,
      },
    ]);

    const res = await request(app)
      .get("/api/v1/auth/access-profile")
      .set("x-test-role", "Employee")
      .set("x-test-user-id", String(OPERATEUR_ID));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ contract_version: 1, cache_ttl_seconds: 10 });
    expect(res.body.is_superadmin).toBe(false);
    expect(res.body.modules[0]).toMatchObject({ module_key: "clients", allowed: true, source: "DEFAULT" });
  });

  it("PATCH /admin/users/:id refuse explicitement is_superadmin (aucune ignorance silencieuse)", async () => {
    repo.repoIsSuperadmin.mockResolvedValue(true);
    const res = await request(app)
      .patch("/api/v1/admin/users/9")
      .set("x-test-role", "Directeur")
      .set("x-test-user-id", String(SUPERADMIN_ID))
      .send({ is_superadmin: true });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "VALIDATION_ERROR" });
  });

  it("conserve les routes de reset admin derrière le RBAC administrateur", async () => {
    const anonymous = await request(app).post("/api/v1/admin/users/9/password-reset-token");
    expect(anonymous.status).toBe(401);

    const tokenAsEmployee = await request(app)
      .post("/api/v1/admin/users/9/password-reset-token")
      .set("x-test-role", "Employee");
    expect(tokenAsEmployee.status).toBe(403);

    const resetAsEmployee = await request(app)
      .patch("/api/v1/admin/users/9/password")
      .set("x-test-role", "Employee")
      .send({ token: "one-use-admin-token", newPassword: "S3cure-password!" });
    expect(resetAsEmployee.status).toBe(403);
  });
});
