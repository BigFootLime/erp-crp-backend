/**
 * #162 — Non-régression des 7 constats P0 du module clients :
 *  1. GET clients/analytics/contacts/adresses/détail : authentification requise,
 *     IBAN/BIC/phone_personal absents de la liste, IBAN masqué en détail hors rôles finance.
 *  2. Mutations : RBAC deny-by-default (rôles existants uniquement).
 *  3. Contact principal : appartenance au client imposée, sous transaction.
 *  4. DELETE : archivage logique, aucune destruction physique.
 *  5. Aucun MAX+1 : le code visible vient de fn_next_issued_code_value (ADR-0013).
 *  6. client_code : serveur et immuable (400 explicite si fourni) ; doublon SIRET -> 409.
 *  7. Logs HTTP sans query string (PII des recherches).
 */
import request from "supertest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// authenticateToken simulé (401 sans en-tête de test, req.user sinon) ;
// authorizeRole RÉEL — c'est précisément le RBAC qu'on veut tester.
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
      req.user = { id: 1, username: "t", email: "t@t.t", role };
      next();
    },
  };
});

import app from "../config/app";
import { stripQueryFromUrl } from "../utils/logPath";
import { maskIban } from "../module/client/client.permissions";

const VALID_CREATE_PAYLOAD = {
  company_name: "Usinage Fictif SAS",
  status: "prospect",
  blocked: false,
  creation_date: "2026-07-20T00:00:00Z",
  bill_address: { name: "Facturation", street: "1 rue des Essais", postal_code: "69001", city: "Lyon", country: "France" },
  delivery_address: { name: "Livraison", street: "1 rue des Essais", postal_code: "69001", city: "Lyon", country: "France" },
};

function sqls(): string[] {
  return mocks.clientQuery.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.clientQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientRelease.mockReset();

  mocks.poolQuery.mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  mocks.clientQuery.mockImplementation((sql: unknown) => {
    const s = String(sql);
    if (s.includes("fn_next_issued_code_value")) return Promise.resolve({ rows: [{ v: "7" }] });
    if (s.includes("INSERT INTO adresse_facturation")) return Promise.resolve({ rows: [{ bill_address_id: "b1" }] });
    if (s.includes("INSERT INTO adresse_livraison")) return Promise.resolve({ rows: [{ delivery_address_id: "d1" }] });
    if (s.includes("INSERT INTO clients")) return Promise.resolve({ rows: [{ client_id: "007" }] });
    if (s.includes("WHERE siret = $1")) return Promise.resolve({ rows: [] });
    if (s.includes("FOR UPDATE")) {
      return Promise.resolve({
        rows: [{ client_id: "001", bill_address_id: "b1", delivery_address_id: "d1", bank_info_id: null, primary_contact_id: null, contact_id: null, company_name: "X", status: "client" }],
      });
    }
    return Promise.resolve({ rows: [{ id: 1, created_at: "2026-07-20T00:00:00.000Z" }] });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("P0-1 — authentification obligatoire sur toutes les routes clients", () => {
  it.each([
    ["GET", "/api/v1/clients"],
    ["GET", "/api/v1/clients/analytics"],
    ["GET", "/api/v1/clients/001"],
    ["GET", "/api/v1/clients/001/contacts"],
    ["GET", "/api/v1/clients/001/addresses"],
  ])("%s %s sans jeton -> 401", async (method, url) => {
    const res = await (method === "GET" ? request(app).get(url) : request(app).post(url));
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/clients authentifié (Employee) -> 200, lecture ouverte aux rôles non-gestionnaires", async () => {
    const res = await request(app).get("/api/v1/clients").set("x-test-role", "Employee");
    expect(res.status).toBe(200);
  });
});

describe("P0-1 — minimisation des DTO", () => {
  it("la requête SQL de liste ne sélectionne ni IBAN, ni BIC, ni phone_personal", async () => {
    await request(app).get("/api/v1/clients").set("x-test-role", "Employee");
    const listSql = String(mocks.poolQuery.mock.calls[0]?.[0] ?? "");
    expect(listSql.length).toBeGreaterThan(0);
    expect(listSql).not.toMatch(/\biban\b/i);
    expect(listSql).not.toMatch(/\bbic\b/i);
    expect(listSql).not.toContain("phone_personal");
  });

  it("détail : IBAN masqué et BIC/phone_personal null pour un rôle non-finance (Employee)", async () => {
    mocks.poolQuery.mockImplementation((sql: unknown) => {
      const s = String(sql);
      if (s.includes("FROM clients c")) {
        return Promise.resolve({
          rows: [{
            client_id: "001", client_code: "CLI-001", company_name: "X", email: null, phone: null,
            website_url: null, siret: null, vat_number: null, naf_code: null, status: "client",
            blocked: false, reason: null, creation_date: "2026-01-01", observations: null,
            provided_documents_id: null, biller_id: null, biller_name: null,
            bill_address_id: "b1", bill_name: "F", bill_street: "r", bill_house_number: null,
            bill_address_complement: null, bill_postal_code: "69001", bill_city: "Lyon", bill_country: "France",
            delivery_address_id: "d1", deliv_name: "L", deliv_street: "r", deliv_house_number: null,
            deliv_address_complement: null, deliv_postal_code: "69001", deliv_city: "Lyon", deliv_country: "France",
            bank_info_id: "k1", bank_name: "Banque Fictive", iban: "FR7630001007941234567890185", bic: "BDFEFRPP",
            contact_id: "c0ffee00-0000-4000-8000-000000000001", first_name: "Ana", last_name: "Bode",
            civility: null, role: null, phone_direct: "+33400000000", phone_personal: "+33600000000",
            contact_email: "ana@fictif.fr",
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const asEmployee = await request(app).get("/api/v1/clients/001").set("x-test-role", "Employee");
    expect(asEmployee.status).toBe(200);
    expect(asEmployee.body.bank.iban).toBe("••••0185");
    expect(asEmployee.body.bank.bic).toBeNull();
    expect(asEmployee.body.bank.iban_masked).toBe(true);
    expect(asEmployee.body.primary_contact.phone_personal).toBeNull();

    const asDirecteur = await request(app).get("/api/v1/clients/001").set("x-test-role", "Directeur");
    expect(asDirecteur.status).toBe(200);
    expect(asDirecteur.body.bank.iban).toBe("FR7630001007941234567890185");
    expect(asDirecteur.body.bank.bic).toBe("BDFEFRPP");
    expect(asDirecteur.body.bank.iban_masked).toBe(false);
    expect(asDirecteur.body.primary_contact.phone_personal).toBe("+33600000000");
  });
});

describe("P0-2 — RBAC deny-by-default sur les mutations", () => {
  it.each(["Employee", "Responsable Programmation", "Responsable Qualité", "Responsable RH"])(
    "POST /api/v1/clients en %s -> 403",
    async (role) => {
      const res = await request(app).post("/api/v1/clients").set("x-test-role", role).send(VALID_CREATE_PAYLOAD);
      expect(res.status).toBe(403);
    }
  );

  it.each(["Directeur", "Administrateur Systeme et Reseau", "Secretaire"])(
    "POST /api/v1/clients en %s -> 201",
    async (role) => {
      const res = await request(app).post("/api/v1/clients").set("x-test-role", role).send(VALID_CREATE_PAYLOAD);
      expect(res.status).toBe(201);
    }
  );

  it("DELETE en Employee -> 403 ; PATCH en Employee -> 403", async () => {
    const del = await request(app).delete("/api/v1/clients/001").set("x-test-role", "Employee");
    expect(del.status).toBe(403);
    const patch = await request(app).patch("/api/v1/clients/001").set("x-test-role", "Employee").send({ phone: "+33612345678" });
    expect(patch.status).toBe(403);
  });
});

describe("P0-5/P0-6 — code client serveur, immuable, sans MAX+1", () => {
  it("POST minimal -> 201 avec code généré par fn_next_issued_code_value, jamais de MAX(client_id)", async () => {
    const res = await request(app).post("/api/v1/clients").set("x-test-role", "Secretaire").send(VALID_CREATE_PAYLOAD);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ client_id: "007", client_code: "CLI-007" });
    expect(sqls().some((s) => s.includes("fn_next_issued_code_value"))).toBe(true);
    expect(sqls().some((s) => s.includes("MAX(client_id"))).toBe(false);
  });

  it("POST avec client_code fourni -> 400 CLIENT_CODE_READONLY (aucune écriture)", async () => {
    const res = await request(app)
      .post("/api/v1/clients")
      .set("x-test-role", "Secretaire")
      .send({ ...VALID_CREATE_PAYLOAD, client_code: "CLI-042" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CLIENT_CODE_READONLY");
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  it("POST avec client_code vide (payloads legacy) -> toléré, code généré serveur", async () => {
    const res = await request(app)
      .post("/api/v1/clients")
      .set("x-test-role", "Secretaire")
      .send({ ...VALID_CREATE_PAYLOAD, client_code: "" });
    expect(res.status).toBe(201);
    expect(res.body.client_code).toBe("CLI-007");
  });

  it("PATCH avec client_code -> 400 CLIENT_CODE_IMMUTABLE", async () => {
    const res = await request(app)
      .patch("/api/v1/clients/001")
      .set("x-test-role", "Secretaire")
      .send({ client_code: "CLI-999" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CLIENT_CODE_IMMUTABLE");
  });

  it("double soumission du même SIRET -> 409 CLIENT_SIRET_EXISTS avec la fiche existante", async () => {
    mocks.clientQuery.mockImplementation((sql: unknown) => {
      const s = String(sql);
      if (s.includes("WHERE siret = $1")) {
        return Promise.resolve({ rows: [{ client_id: "003", company_name: "Déjà Là SARL", client_code: "CLI-003" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app)
      .post("/api/v1/clients")
      .set("x-test-role", "Secretaire")
      .send({ ...VALID_CREATE_PAYLOAD, siret: "12345678900011" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CLIENT_SIRET_EXISTS");
    expect(res.body.details).toEqual({ client_id: "003", company_name: "Déjà Là SARL", client_code: "CLI-003" });
    expect(sqls().some((s) => s.includes("INSERT INTO clients"))).toBe(false);
  });
});

describe("P0-6 — duplicate-check (corps POST, jamais de query string)", () => {
  it("POST /duplicate-check sans critère -> 400", async () => {
    const res = await request(app).post("/api/v1/clients/duplicate-check").set("x-test-role", "Employee").send({});
    expect(res.status).toBe(400);
  });

  it("POST /duplicate-check avec SIRET -> 200 { candidates } minimisés", async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [{ client_id: "003", client_code: "CLI-003", company_name: "Déjà Là SARL", status: "client", siret: "12345678900011", vat_number: null }],
    });
    const res = await request(app)
      .post("/api/v1/clients/duplicate-check")
      .set("x-test-role", "Employee")
      .send({ siret: "12345678900011" });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([
      { client_id: "003", client_code: "CLI-003", company_name: "Déjà Là SARL", status: "client", matched_on: ["siret"] },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("iban");
  });
});

describe("P0-3 — contact principal : appartenance + transaction", () => {
  const CONTACT_ID = "c0ffee00-0000-4000-8000-000000000002";

  it("contact d'un autre client -> 422 CONTACT_NOT_OF_CLIENT, aucun UPDATE clients", async () => {
    mocks.clientQuery.mockImplementation((sql: unknown) => {
      const s = String(sql);
      if (s.includes("FOR UPDATE")) return Promise.resolve({ rows: [{ contact_id: null }] });
      if (s.includes("FROM contacts WHERE contact_id")) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ id: 1, created_at: "2026-07-20T00:00:00.000Z" }] });
    });
    const res = await request(app)
      .patch("/api/v1/clients/001/contact")
      .set("x-test-role", "Secretaire")
      .send({ contact_id: CONTACT_ID });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("CONTACT_NOT_OF_CLIENT");
    expect(sqls().some((s) => s.includes("UPDATE clients SET contact_id"))).toBe(false);
    expect(sqls()).toContain("ROLLBACK");
  });

  it("contact du client -> 204, bascule + audit dans la même transaction", async () => {
    mocks.clientQuery.mockImplementation((sql: unknown) => {
      const s = String(sql);
      if (s.includes("FOR UPDATE")) return Promise.resolve({ rows: [{ contact_id: null }] });
      if (s.includes("FROM contacts WHERE contact_id")) return Promise.resolve({ rows: [{ "?column?": 1 }] });
      return Promise.resolve({ rows: [{ id: 1, created_at: "2026-07-20T00:00:00.000Z" }] });
    });
    const res = await request(app)
      .patch("/api/v1/clients/001/contact")
      .set("x-test-role", "Secretaire")
      .send({ contact_id: CONTACT_ID });
    expect(res.status).toBe(204);
    const emitted = sqls();
    expect(emitted).toContain("BEGIN");
    expect(emitted.some((s) => s.includes("UPDATE clients SET contact_id"))).toBe(true);
    expect(emitted.some((s) => s.includes("erp_audit_logs"))).toBe(true);
    expect(emitted).toContain("COMMIT");
  });

  it("contact_id non uuid -> 400 de validation", async () => {
    const res = await request(app)
      .patch("/api/v1/clients/001/contact")
      .set("x-test-role", "Secretaire")
      .send({ contact_id: "pas-un-uuid" });
    expect(res.status).toBe(400);
  });
});

describe("P0-4 — DELETE = archivage logique, aucune destruction", () => {
  it("DELETE -> 204 : status inactif + blocked, aucun DELETE physique, audit en mode logical_archive", async () => {
    const res = await request(app).delete("/api/v1/clients/001").set("x-test-role", "Directeur");
    expect(res.status).toBe(204);
    const emitted = sqls();
    expect(emitted.some((s) => s.includes("DELETE FROM clients"))).toBe(false);
    expect(emitted.some((s) => s.includes("DELETE FROM contacts"))).toBe(false);
    expect(emitted.some((s) => s.includes("DELETE FROM client_payment_modes"))).toBe(false);
    expect(emitted.some((s) => s.includes("SET status = 'inactif', blocked = true"))).toBe(true);
    expect(emitted.some((s) => s.includes("erp_audit_logs"))).toBe(true);
  });
});

describe("P0-7 — aucune query string dans les logs HTTP", () => {
  it("stripQueryFromUrl retire query et fragment, conserve le chemin", () => {
    expect(stripQueryFromUrl("/api/v1/clients?q=jane%40doe.fr&limit=25")).toBe("/api/v1/clients");
    expect(stripQueryFromUrl("/api/v1/clients#frag")).toBe("/api/v1/clients");
    expect(stripQueryFromUrl("/api/v1/clients/001")).toBe("/api/v1/clients/001");
    expect(stripQueryFromUrl(undefined)).toBeNull();
    expect(stripQueryFromUrl("")).toBeNull();
  });

  it("le log http_request d'une recherche ne contient pas l'email cherché", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await request(app).get("/api/v1/clients?q=jane%40doe.fr").set("x-test-role", "Employee");
    const httpLines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("http_request"));
    expect(httpLines.length).toBeGreaterThan(0);
    for (const line of httpLines) {
      expect(line).not.toContain("jane");
      expect(line).not.toContain("q=");
    }
    const parsed = JSON.parse(httpLines[httpLines.length - 1]);
    expect(parsed.path).toBe("/api/v1/clients");
  });
});

describe("maskIban", () => {
  it("garde uniquement les 4 derniers caractères", () => {
    expect(maskIban("FR76 3000 1007 9412 3456 7890 185")).toBe("••••0185");
    expect(maskIban(null)).toBeNull();
    expect(maskIban("")).toBeNull();
    expect(maskIban("AB12")).toBe("••••");
  });
});
