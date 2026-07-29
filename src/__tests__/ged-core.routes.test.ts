import { EventEmitter } from "events";

import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  targetExists: true,
  linkedDocument: true,
  readBlob: vi.fn(),
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
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: {
      user?: {
        id: number;
        username: string;
        email: string;
        role: string;
        primary_role: string;
        roles: string[];
      };
      headers: Record<string, unknown>;
    },
    _res: unknown,
    next: () => void
  ) => {
    if (req.headers["x-test-unauthenticated"] === "true") {
      next();
      return;
    }
    const role =
      typeof req.headers["x-test-role"] === "string"
        ? (req.headers["x-test-role"] as string)
        : "Administrateur Systeme et Reseau";
    req.user = {
      id: 1,
      username: "test-user",
      email: "user@example.test",
      role,
      primary_role: role,
      roles: [role],
    };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../module/ged/services/ged-vault.service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../module/ged/services/ged-vault.service")>();
  return {
    ...actual,
    readBlob: mocks.readBlob,
  };
});

import app from "../config/app";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PARENT_ID = "44444444-4444-4444-8444-444444444444";
const SHA = "b".repeat(64);

const CLASS_ROW = {
  class_key: "PLAN_CLIENT",
  domain: "TECHNIQUE",
  label: "Plan client",
  nature: "SOURCE",
  allowed_mime_types: ["application/pdf"],
  allowed_extensions: [".pdf"],
  max_size_bytes: "104857600",
  approvals_required: 1,
  retention_months: 120,
  hold_on_publish: false,
  is_active: true,
};

const DOCUMENT_ROW = {
  id: DOCUMENT_ID,
  code: "DT-000001",
  class_key: "PLAN_CLIENT",
  class_label: "Plan client",
  domain: "TECHNIQUE",
  title: "Plan 1234 indice B",
  description: null,
  current_version_number: 1,
  current_version_status: "APPLICABLE",
  versions_count: 1,
  has_active_hold: false,
  created_at: "2026-07-27T10:00:00.000Z",
  updated_at: "2026-07-27T10:00:00.000Z",
  archived_at: null,
  access_scope_entity_type: "PIECE_TECHNIQUE_VERSION",
  access_scope_entity_id: PARENT_ID,
};

const VERSION_ROW = {
  id: VERSION_ID,
  document_id: DOCUMENT_ID,
  version_number: 1,
  status: "APPLICABLE",
  original_name: "plan.pdf",
  mime_type: "application/pdf",
  size_bytes: "1024",
  sha256: SHA,
  change_reason: null,
  created_at: "2026-07-27T10:00:00.000Z",
  submitted_at: null,
  approved_at: null,
  published_at: "2026-07-27T10:05:00.000Z",
  obsoleted_at: null,
  cu_id: 1,
  cu_username: "keenan",
  cu_name: "Keenan",
  cu_surname: "Martin",
  au_id: null,
  au_username: null,
  au_name: null,
  au_surname: null,
};

const CAPABILITIES = new Set([
  "read",
  "upload",
  "update_metadata",
  "checkout",
  "checkin",
  "submit",
  "approve",
  "publish",
  "obsolete",
  "download",
  "export",
  "admin",
]);

function roleKeysFrom(params: unknown[]): string[] {
  return (params.find((value) => Array.isArray(value)) as string[] | undefined) ?? [];
}

function capabilityFrom(params: unknown[]): string {
  return (
    (params.find(
      (value) => typeof value === "string" && CAPABILITIES.has(value)
    ) as string | undefined) ?? "read"
  );
}

function hasAnyCapability(roleKeys: string[], capability: string): boolean {
  if (roleKeys.includes("Administrateur Systeme et Reseau")) return true;
  if (roleKeys.includes("stagiaire-externe")) return false;
  if (roleKeys.includes("Directeur")) {
    return ["read", "download", "export"].includes(capability);
  }
  if (roleKeys.includes("Études-Méthodes")) {
    return [
      "read",
      "upload",
      "update_metadata",
      "checkout",
      "checkin",
      "submit",
      "download",
      "export",
    ].includes(capability);
  }
  if (roleKeys.includes("Responsable Qualité")) {
    return true;
  }
  if (roleKeys.includes("Responsable Atelier-Production")) {
    return ["read", "upload", "download"].includes(capability);
  }
  return false;
}

function canReadTechnicalTarget(roleKeys: string[]): boolean {
  return (
    roleKeys.includes("Administrateur Systeme et Reseau") ||
    roleKeys.includes("Études-Méthodes")
  );
}

function scopeMatches(params: unknown[]): boolean {
  if (!mocks.linkedDocument) return true;
  const roleKeys = roleKeysFrom(params);
  if (roleKeys.includes("Administrateur Systeme et Reseau")) return true;
  return params.includes("PIECE_TECHNIQUE_VERSION") && params.includes(PARENT_ID);
}

function defaultQuery(sqlInput: unknown, paramsInput?: unknown[]) {
  const sql = String(sqlInput);
  const params = paramsInput ?? [];
  const roleKeys = roleKeysFrom(params);
  const capability = capabilityFrom(params);

  if (sql.includes("INSERT INTO public.ged_access_events")) {
    return { rows: [] };
  }
  if (sql.includes("public.piece_technique_versions") && sql.includes("AS found")) {
    return { rows: [{ found: mocks.targetExists }] };
  }
  if (sql.includes("ged_class_capabilities") && sql.includes("AS granted")) {
    return { rows: [{ granted: hasAnyCapability(roleKeys, capability) }] };
  }
  if (
    sql.includes("FROM public.ged_class_capabilities cap") &&
    sql.includes("AS granted")
  ) {
    return { rows: [{ granted: hasAnyCapability(roleKeys, capability) }] };
  }
  if (
    sql.includes("FROM public.ged_document_classes c") &&
    sql.includes("ORDER BY c.domain")
  ) {
    return { rows: hasAnyCapability(roleKeys, capability) ? [CLASS_ROW] : [] };
  }
  if (
    sql.includes("FROM public.ged_document_classes") &&
    sql.includes("WHERE class_key = $1")
  ) {
    return { rows: [CLASS_ROW] };
  }
  if (sql.includes("SELECT COUNT(*)::int AS total")) {
    return { rows: [{ total: canReadTechnicalTarget(roleKeys) ? 1 : 0 }] };
  }
  if (sql.includes("SELECT") && sql.includes("AS access_scope_entity_type")) {
    if (sql.includes("WHERE d.id = $1::uuid")) {
      return {
        rows:
          params[0] === DOCUMENT_ID &&
          canReadTechnicalTarget(roleKeys) &&
          scopeMatches(params)
            ? [DOCUMENT_ROW]
            : [],
      };
    }
    return { rows: canReadTechnicalTarget(roleKeys) ? [DOCUMENT_ROW] : [] };
  }
  if (sql.includes("b.storage_key")) {
    return {
      rows:
        canReadTechnicalTarget(roleKeys) && scopeMatches(params)
          ? [
              {
                version_id: VERSION_ID,
                document_id: DOCUMENT_ID,
                class_key: "PLAN_CLIENT",
                status: "APPLICABLE",
                original_name: "plan.pdf",
                mime_type: "application/pdf",
                sha256: SHA,
                storage_key: `vault/sha256/bb/bb/${SHA}`,
              },
            ]
          : [],
    };
  }
  if (sql.includes("FROM public.ged_document_versions v") && sql.includes("b.mime_type")) {
    return { rows: [VERSION_ROW] };
  }
  if (sql.includes("FROM public.ged_document_links")) {
    return {
      rows: mocks.linkedDocument
        ? [
            {
              id: "55555555-5555-4555-8555-555555555555",
              entity_type: "PIECE_TECHNIQUE_VERSION",
              entity_id: PARENT_ID,
              link_role: "PLAN",
              created_at: "2026-07-27T10:00:00.000Z",
            },
          ]
        : [],
    };
  }
  if (
    sql.includes("FROM public.ged_retention_holds") ||
    sql.includes("FROM public.ged_checkouts")
  ) {
    return { rows: [] };
  }
  if (sql.includes("FROM public.ged_access_events e")) {
    return { rows: [] };
  }
  return { rows: [] };
}

const VAULT_PATH_MARKERS = [
  "storage_path",
  "storage_key",
  "stored_name",
  "/srv/cerp",
  "/mnt/cerp-ged",
  "/app/data",
  "vault/sha256",
];

function assertNoPathLeak(payload: unknown) {
  const serialized = JSON.stringify(payload ?? {});
  for (const marker of VAULT_PATH_MARKERS) {
    expect(serialized).not.toContain(marker);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.targetExists = true;
  mocks.linkedDocument = true;
  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
  mocks.poolQuery.mockImplementation(defaultQuery);
  mocks.readBlob.mockResolvedValue(Buffer.from("%PDF-1.7\nsecure"));
  delete process.env.CERP_GED_VAULT_ROOT;
  process.env.CERP_GED_REQUIRE_SENTINEL = "false";
});

describe("GED — authentification et RBAC par classe", () => {
  it("refuse une requête sans utilisateur authentifié", async () => {
    const res = await request(app)
      .get("/api/v1/ged/classes")
      .set("x-test-unauthenticated", "true");
    expect(res.status).toBe(401);
  });

  it("refuse par défaut un rôle inconnu", async () => {
    const res = await request(app)
      .get("/api/v1/ged/classes")
      .set("x-test-role", "stagiaire-externe");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("GED_CAPABILITY_REQUIRED");
  });

  it("ne confond pas lecture et dépôt", async () => {
    const res = await request(app)
      .post("/api/v1/ged/documents")
      .set("x-test-role", "Directeur")
      .field("class_key", "PLAN_CLIENT")
      .field("title", "Essai");
    expect(res.status).toBe(403);
  });

  it("renvoie 404 pour une classe cible hors périmètre d'un rôle pourtant habilité ailleurs", async () => {
    const res = await request(app)
      .get(`/api/v1/ged/documents/${DOCUMENT_ID}`)
      .set("x-test-role", "Responsable Qualité")
      .query({ entity_type: "PIECE_TECHNIQUE_VERSION", entity_id: PARENT_ID });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toContain("GED_DOCUMENT_NOT_FOUND");
  });
});

describe("GED — contrôle parent/cible et anti-IDOR", () => {
  it("refuse un UUID lié présenté sans son parent", async () => {
    const res = await request(app)
      .get(`/api/v1/ged/documents/${DOCUMENT_ID}`)
      .set("x-test-role", "Études-Méthodes");
    expect(res.status).toBe(404);
  });

  it("refuse le document valide avec un parent différent", async () => {
    const res = await request(app)
      .get(`/api/v1/ged/documents/${DOCUMENT_ID}`)
      .set("x-test-role", "Études-Méthodes")
      .query({
        entity_type: "PIECE_TECHNIQUE_VERSION",
        entity_id: OTHER_PARENT_ID,
      });
    expect(res.status).toBe(404);
  });

  it("refuse un identifiant de document deviné même avec un parent valide", async () => {
    const guessedId = "99999999-9999-4999-8999-999999999999";
    const res = await request(app)
      .get(`/api/v1/ged/documents/${guessedId}`)
      .set("x-test-role", "Études-Méthodes")
      .query({
        entity_type: "PIECE_TECHNIQUE_VERSION",
        entity_id: PARENT_ID,
      });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toContain("GED_DOCUMENT_NOT_FOUND");
  });

  it("refuse un périmètre partiel ou un type de parent non supporté", async () => {
    const partial = await request(app)
      .get(`/api/v1/ged/documents/${DOCUMENT_ID}`)
      .set("x-test-role", "Études-Méthodes")
      .query({ entity_type: "PIECE_TECHNIQUE_VERSION" });
    expect(partial.status).toBe(400);

    const unsupported = await request(app)
      .get(`/api/v1/ged/documents/${DOCUMENT_ID}`)
      .set("x-test-role", "Études-Méthodes")
      .query({ entity_type: "COMMANDE_CLIENT", entity_id: PARENT_ID });
    expect(unsupported.status).toBe(400);
  });

  it("autorise le couple parent/cible exact et journalise READ", async () => {
    const res = await request(app)
      .get(`/api/v1/ged/documents/${DOCUMENT_ID}`)
      .set("x-test-role", "Études-Méthodes")
      .query({
        entity_type: "PIECE_TECHNIQUE_VERSION",
        entity_id: PARENT_ID,
      });
    expect(res.status).toBe(200);
    assertNoPathLeak(res.body);
    expect(res.body.data.access_scope).toEqual({
      entity_type: "PIECE_TECHNIQUE_VERSION",
      entity_id: PARENT_ID,
    });

    const auditCall = mocks.poolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO public.ged_access_events")
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[1]?.[2]).toBe("READ");
    assertNoPathLeak(auditCall?.[1]);
  });

  it("refuse un rattachement vers un parent inexistant avant toute écriture", async () => {
    mocks.targetExists = false;
    const res = await request(app)
      .post("/api/v1/ged/documents")
      .set("x-test-role", "Études-Méthodes")
      .field("class_key", "PLAN_CLIENT")
      .field("title", "Plan orphelin")
      .field("entity_type", "PIECE_TECHNIQUE_VERSION")
      .field("entity_id", OTHER_PARENT_ID)
      .attach("file", Buffer.from("%PDF-1.7\nfake"), {
        filename: "plan.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toContain("GED_LINK_TARGET_NOT_FOUND");
  });
});

describe("GED — validation, disponibilité et contrat", () => {
  it("répond 503 lorsque les tables de sécurité GED sont absentes", async () => {
    const undefinedTable = Object.assign(
      new Error('relation "ged_class_capabilities" does not exist'),
      { code: "42P01" }
    );
    mocks.poolQuery.mockRejectedValueOnce(undefinedTable);

    const res = await request(app).get("/api/v1/ged/classes");
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain("GED_NOT_INSTALLED");
  });

  it("refuse le dépôt en 503 quand le coffre est indisponible", async () => {
    const res = await request(app)
      .post("/api/v1/ged/documents")
      .field("class_key", "PLAN_CLIENT")
      .field("title", "Plan initial")
      .attach("file", Buffer.from("%PDF-1.7\nfake"), {
        filename: "plan.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain("GED_VAULT_UNAVAILABLE");
  });

  it("refuse un exécutable renommé en PDF avant toute écriture", async () => {
    const res = await request(app)
      .post("/api/v1/ged/documents")
      .field("class_key", "PLAN_CLIENT")
      .field("title", "Faux plan")
      .attach("file", Buffer.from([0x4d, 0x5a, 0x90, 0x00]), {
        filename: "plan.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(415);
    expect(JSON.stringify(res.body)).toContain("GED_FILE_SIGNATURE");
  });

  it("ne renvoie aucun chemin physique dans la recherche", async () => {
    const res = await request(app).get("/api/v1/ged/documents");
    expect(res.status).toBe(200);
    assertNoPathLeak(res.body);
    expect(res.body.data[0].code).toBe("DT-000001");
    expect(res.body.data[0].sha256).toBeUndefined();
  });

  it("télécharge par la route authentifiée, avec périmètre exact et audit obligatoire", async () => {
    const res = await request(app)
      .get(`/api/v1/ged/versions/${VERSION_ID}/content`)
      .set("x-test-role", "Études-Méthodes")
      .query({
        entity_type: "PIECE_TECHNIQUE_VERSION",
        entity_id: PARENT_ID,
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(mocks.readBlob).toHaveBeenCalledWith(`vault/sha256/bb/bb/${SHA}`, SHA);

    const auditCall = mocks.poolQuery.mock.calls.find(
      ([sql, params]) =>
        String(sql).includes("INSERT INTO public.ged_access_events") &&
        Array.isArray(params) &&
        params[2] === "DOWNLOAD"
    );
    expect(auditCall).toBeDefined();
    assertNoPathLeak(auditCall?.[1]);
  });

  it("refuse de servir un fichier si la trace DOWNLOAD ne peut pas être écrite", async () => {
    mocks.poolQuery.mockImplementation((sql, params) => {
      if (
        String(sql).includes("INSERT INTO public.ged_access_events") &&
        Array.isArray(params) &&
        params[2] === "DOWNLOAD"
      ) {
        return Promise.reject(new Error("audit indisponible"));
      }
      return defaultQuery(sql, params);
    });

    const res = await request(app)
      .get(`/api/v1/ged/versions/${VERSION_ID}/content`)
      .set("x-test-role", "Études-Méthodes")
      .query({
        entity_type: "PIECE_TECHNIQUE_VERSION",
        entity_id: PARENT_ID,
      });

    expect(res.status).toBe(500);
    assertNoPathLeak(res.body);
  });
});
