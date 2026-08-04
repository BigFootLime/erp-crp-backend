// GED centrale CERP (ADR-0037) — tests de routes et de contrat.
//
// Deux garanties sont vérifiées ici et devront le rester :
//   1. AUCUNE réponse ne contient de chemin physique.
//   2. Un coffre indisponible produit un 503 explicite, jamais un repli local.

import request from "supertest";
import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; username: string; email: string; role: string }; headers: Record<string, unknown> },
    _res: unknown,
    next: () => void
  ) => {
    const roleHeader =
      typeof req.headers["x-test-role"] === "string" ? (req.headers["x-test-role"] as string) : "administrateur";
    req.user = { id: 1, username: "test-admin", email: "admin@example.test", role: roleHeader };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

const SHA = "b".repeat(64);
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
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  delete process.env.CERP_GED_VAULT_ROOT;
  process.env.CERP_GED_REQUIRE_SENTINEL = "false";
});

describe("GED — RBAC des routes", () => {
  it("refuse la lecture à un rôle non habilité", async () => {
    const res = await request(app).get("/api/v1/ged/classes").set("x-test-role", "stagiaire-externe");
    expect(res.status).toBe(403);
    expect(res.body?.code ?? res.body?.error?.code).toBeDefined();
  });

  it("refuse le dépôt à un rôle en lecture seule", async () => {
    const res = await request(app)
      .post("/api/v1/ged/documents")
      .set("x-test-role", "Atelier")
      .field("class_key", "PLAN_CLIENT")
      .field("title", "Essai");
    expect(res.status).toBe(403);
  });

  it("refuse l'approbation à un rôle atelier", async () => {
    const res = await request(app)
      .post(`/api/v1/ged/versions/${"1".repeat(8)}-1111-4111-8111-111111111111/approve`)
      .set("x-test-role", "Atelier")
      .send({});
    expect(res.status).toBe(403);
  });
});

describe("GED — schéma absent", () => {
  it("répond 503 GED_NOT_INSTALLED plutôt qu'un 500 opaque", async () => {
    const undefinedTable = Object.assign(new Error('relation "ged_document_classes" does not exist'), {
      code: "42P01",
    });
    mocks.poolQuery.mockRejectedValueOnce(undefinedTable);

    const res = await request(app).get("/api/v1/ged/classes").set("x-test-role", "administrateur");
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain("GED_NOT_INSTALLED");
  });
});

describe("GED — coffre indisponible", () => {
  it("refuse le dépôt en 503 et ne crée aucun répertoire de repli", async () => {
    // CERP_GED_VAULT_ROOT volontairement absent : c'est exactement le scénario
    // qui, ailleurs dans le code historique, produit un dossier local silencieux.
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
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
        },
      ],
    });

    const res = await request(app)
      .post("/api/v1/ged/documents")
      .set("x-test-role", "administrateur")
      .field("class_key", "PLAN_CLIENT")
      .field("title", "Plan de contrôle initial")
      .attach("file", Buffer.from("%PDF-1.7\nfake"), { filename: "plan.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain("GED_VAULT_UNAVAILABLE");
  });
});

describe("GED — contrôle de contenu au niveau route", () => {
  it("refuse un exécutable renommé en .pdf avant toute écriture", async () => {
    const res = await request(app)
      .post("/api/v1/ged/documents")
      .set("x-test-role", "administrateur")
      .field("class_key", "PLAN_CLIENT")
      .field("title", "Faux plan")
      .attach("file", Buffer.from([0x4d, 0x5a, 0x90, 0x00]), {
        filename: "plan.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(415);
    expect(JSON.stringify(res.body)).toContain("UPLOAD_EXECUTABLE_FORBIDDEN");
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });
});

describe("GED — contrat : aucune fuite de chemin", () => {
  it("ne renvoie aucun marqueur de chemin dans la liste des documents", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            code: "DT-000001",
            class_key: "PLAN_CLIENT",
            class_label: "Plan client",
            domain: "TECHNIQUE",
            title: "Plan 1234 indice B",
            description: null,
            current_version_number: 2,
            current_version_status: "APPLICABLE",
            versions_count: 2,
            has_active_hold: false,
            created_at: "2026-07-27T10:00:00.000Z",
            updated_at: "2026-07-27T11:00:00.000Z",
            archived_at: null,
          },
        ],
      });

    const res = await request(app).get("/api/v1/ged/documents").set("x-test-role", "administrateur");
    expect(res.status).toBe(200);
    assertNoPathLeak(res.body);
    expect(res.body.data[0].code).toBe("DT-000001");
    expect(res.body.data[0].sha256).toBeUndefined();
  });

  it("ne renvoie aucun marqueur de chemin dans le détail d'un document", async () => {
    const documentId = "11111111-1111-4111-8111-111111111111";
    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: documentId,
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
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            document_id: documentId,
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
            cu_id: 1, cu_username: "keenan", cu_name: "Keenan", cu_surname: "Martin",
            au_id: null, au_username: null, au_name: null, au_surname: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/v1/ged/documents/${documentId}`)
      .set("x-test-role", "administrateur");

    expect(res.status).toBe(200);
    assertNoPathLeak(res.body);
    // L'empreinte, elle, est publiée : c'est une preuve d'intégrité, pas un chemin.
    expect(res.body.data.versions[0].sha256).toBe(SHA);
  });
});
