import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
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

// Auth mock : rôle injecté via l'en-tête `x-test-role` (défaut administrateur) pour tester le RBAC.
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; username: string; email: string; role: string }; headers: Record<string, unknown> },
    _res: unknown,
    next: () => void
  ) => {
    const roleHeader = typeof req.headers["x-test-role"] === "string" ? (req.headers["x-test-role"] as string) : "administrateur";
    req.user = {
      id: 1,
      username: "test-admin",
      email: "admin@example.test",
      role: roleHeader,
    };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
});

describe("/api/v1/affaires", () => {
  it("GET /api/v1/affaires returns {items,total}, filters, sort/pagination, include=client", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 2 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "1",
            reference: "AFF-1",
            client_id: "001",
            commande_id: null,
            devis_id: null,
            type_affaire: "livraison",
            statut: "OUVERTE",
            date_ouverture: "2026-02-01",
            date_cloture: null,
            commentaire: null,
            created_at: "2026-02-01T10:00:00.000Z",
            updated_at: "2026-02-02T10:00:00.000Z",
            client: {
              client_id: "001",
              company_name: "ACME",
              email: "a@acme.test",
              phone: null,
              delivery_address_id: null,
              bill_address_id: null,
            },
          },
        ],
      });

    const res = await request(app).get("/api/v1/affaires").query({
      q: "AFF",
      client_id: "001",
      statut: "OUVERTE",
      type_affaire: "livraison",
      open_from: "2026-01-01",
      open_to: "2026-12-31",
      close_from: "2026-02-01",
      close_to: "2026-02-28",
      page: "2",
      pageSize: "5",
      sortBy: "reference",
      sortDir: "asc",
      include: "client",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 2,
      items: [
        {
          id: 1,
          reference: "AFF-1",
          client_id: "001",
          client: { company_name: "ACME" },
        },
      ],
    });

    expect(typeof res.body.items[0].id).toBe("number");

    expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
    const countCall = mocks.poolQuery.mock.calls[0];
    const dataCall = mocks.poolQuery.mock.calls[1];

    expect(String(countCall[0])).toContain("FROM affaire a");
    expect(String(countCall[0])).toContain("LEFT JOIN clients c");
    expect(countCall[1]).toEqual([
      "%AFF%",
      "001",
      "OUVERTE",
      "livraison",
      "2026-01-01",
      "2026-12-31",
      "2026-02-01",
      "2026-02-28",
    ]);

    expect(String(dataCall[0])).toContain("ORDER BY a.reference ASC");
    expect(dataCall[1]).toEqual([
      "%AFF%",
      "001",
      "OUVERTE",
      "livraison",
      "2026-01-01",
      "2026-12-31",
      "2026-02-01",
      "2026-02-28",
      5,
      5,
    ]);
  });

  it("GET /api/v1/affaires/:id supports include=client,commande,devis and ignores unknown", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "1",
            reference: "AFF-1",
            client_id: "001",
            commande_id: "123",
            devis_id: "55",
            type_affaire: "livraison",
            statut: "OUVERTE",
            date_ouverture: "2026-02-01",
            date_cloture: null,
            commentaire: null,
            created_at: "2026-02-01T10:00:00.000Z",
            updated_at: "2026-02-02T10:00:00.000Z",
            client: {
              client_id: "001",
              company_name: "ACME",
              email: null,
              phone: null,
              delivery_address_id: null,
              bill_address_id: null,
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "123",
            numero: "CC-123",
            client_id: "001",
            date_commande: "2026-02-01",
            total_ht: 100,
            total_ttc: 120,
            updated_at: "2026-02-02T10:00:00.000Z",
            statut: "brouillon",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "55",
            numero: "DV-55",
            client_id: "001",
            date_creation: "2026-02-01T10:00:00.000Z",
            date_validite: "2026-03-01",
            statut: "BROUILLON",
            total_ht: 100,
            total_ttc: 120,
          },
        ],
      });

    const res = await request(app)
      .get("/api/v1/affaires/1")
      .query({ include: "client,commande,devis,unknown" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("affaire");
    expect(res.body.affaire).toMatchObject({
      id: 1,
      reference: "AFF-1",
      client: { company_name: "ACME" },
      commande: { id: 123, numero: "CC-123" },
      devis: { id: 55, numero: "DV-55" },
    });

    const baseSql = String(mocks.poolQuery.mock.calls[0][0]);
    expect(baseSql).toContain("FROM affaire a");
    expect(baseSql).toContain("LEFT JOIN clients c");
    expect(String(mocks.poolQuery.mock.calls[1][0])).toContain("FROM commande_client");
    expect(String(mocks.poolQuery.mock.calls[2][0])).toContain("FROM devis");
  });

  it("GET /api/v1/affaires/command-center returns aggregate ERP rollups", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "1",
            reference: "AFF-1",
            client_id: "001",
            commande_id: "123",
            devis_id: null,
            type_affaire: "livraison",
            statut: "EN_COURS",
            date_ouverture: "2026-02-01",
            date_cloture: null,
            commentaire: null,
            created_at: "2026-02-01T10:00:00.000Z",
            updated_at: "2026-02-02T10:00:00.000Z",
            client: {
              client_id: "001",
              company_name: "ACME",
              email: null,
              phone: null,
              delivery_address_id: null,
              bill_address_id: null,
            },
            commande: {
              id: "123",
              numero: "CC-123",
              statut: "EN_PRODUCTION",
              date_commande: "2026-02-01",
              total_ht: 100,
              total_ttc: 120,
            },
            current_checkpoint: "delivery",
            current_label: "Livraison",
            current_status: "active",
            responsible_role: "logistique",
            blocked_reason: null,
            due_at: null,
            of_count: 2,
            of_done_count: 1,
            of_running_count: 1,
            of_blocked_count: 0,
            of_planned_end_at: "2026-02-10",
            of_last_update_at: "2026-02-03T10:00:00.000Z",
            bl_count: 1,
            bl_delivered_count: 0,
            bl_shipped_count: 0,
            bl_ready_count: 1,
            bl_last_numero: "BL-1",
            bl_planned_at: "2026-02-12",
            bl_delivered_at: null,
            bl_tracking_number: null,
            bl_last_update_at: "2026-02-04T10:00:00.000Z",
            facture_count: 0,
            facture_total_ht: 0,
            facture_total_ttc: 0,
            facture_paid_ttc: 0,
            facture_remaining_ttc: 0,
            facture_last_numero: null,
            facture_last_update_at: null,
            audit_count: 3,
            audit_last_audit_at: "2026-02-05T10:00:00.000Z",
            traceability: [
              {
                section: "affaire",
                source_table: "affaire",
                source_id: "1",
                source_ref: "AFF-1",
                status: "EN_COURS",
                updated_at: "2026-02-02T10:00:00.000Z",
                evidence_count: 1,
              },
            ],
          },
        ],
      });

    const res = await request(app).get("/api/v1/affaires/command-center").query({ segment: "ready_delivery" });

    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      id: 1,
      reference: "AFF-1",
      commande: { id: 123, numero: "CC-123" },
      production: { of_count: 2, open_count: 1, completion_rate: 50 },
      livraison: { bl_count: 1, latest_status: "READY" },
      facturation: { facture_count: 0, open_amount: 0 },
      control: { active_checkpoint_count: 1, audit_event_count: 3 },
      status: { production: "in_progress", livraison: "ready", facturation: "none" },
      next_action: "Livraison",
      traceability: [{ source_table: "affaire", evidence_count: 1 }],
    });
    expect(String(mocks.poolQuery.mock.calls[1][0])).toContain("FROM affaire a");
  });

  // ---------------------------------------------------------------------------
  // #169 — création : code serveur immuable AFF-AAAA-NNNN, jamais fourni par le client
  // ---------------------------------------------------------------------------
  it("POST /api/v1/affaires assigns a server AFF-YYYY-NNNN code and returns {id,reference,updated_at}", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "7" }] }) // nextval(affaire_id_seq)
      .mockResolvedValueOnce({ rows: [{ v: "1" }] }) // fn_next_issued_code_value (AFF:<year>)
      .mockResolvedValueOnce({ rows: [{ id: "7", updated_at: "2026-02-02T10:00:00.000Z" }] }) // INSERT
      .mockResolvedValueOnce({ rows: [{ id: "audit-1", created_at: "2026-02-01T10:00:00.000Z" }] }) // audit
      .mockResolvedValueOnce({ rows: [] }) // pg_notify
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    // Le client tente d'imposer une référence : elle DOIT être ignorée (code serveur).
    const res = await request(app).post("/api/v1/affaires").send({ client_id: "001", reference: "HACK-1" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(7);
    expect(res.body.reference).toMatch(/^AFF-\d{4}-0001$/);
    expect(res.body).toHaveProperty("updated_at", "2026-02-02T10:00:00.000Z");

    const insertCall = mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO affaire"));
    expect(insertCall).toBeTruthy();
    const params = insertCall?.[1] as unknown[];
    expect(params[0]).toBe(7);
    expect(String(params[1])).toMatch(/^AFF-\d{4}-0001$/);
    expect(params[1]).not.toBe("HACK-1"); // le code client est ignoré
  });

  it("POST /api/v1/affaires rejects a livraison without client_id (400 VALIDATION_ERROR)", async () => {
    const res = await request(app).post("/api/v1/affaires").send({ type_affaire: "livraison" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
    expect((res.body.errors as Array<{ field: string }>).some((e) => e.field === "client_id")).toBe(true);
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  it("POST /api/v1/affaires allows a projet without client_id", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "9" }] }) // nextval
      .mockResolvedValueOnce({ rows: [{ v: "2" }] }) // code
      .mockResolvedValueOnce({ rows: [{ id: "9", updated_at: "2026-02-02T10:00:00.000Z" }] }) // INSERT
      .mockResolvedValueOnce({ rows: [{ id: "audit-1", created_at: "2026-02-01T10:00:00.000Z" }] }) // audit
      .mockResolvedValueOnce({ rows: [] }) // notify
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app).post("/api/v1/affaires").send({ type_affaire: "projet" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(9);
  });

  it("POST /api/v1/affaires is forbidden for a read-only role (403)", async () => {
    const res = await request(app).post("/api/v1/affaires").set("x-test-role", "lecture").send({ client_id: "001" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  it("GET /api/v1/affaires is forbidden for an unknown role (403 deny-by-default)", async () => {
    const res = await request(app).get("/api/v1/affaires").set("x-test-role", "role-inconnu");
    expect(res.status).toBe(403);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // #169 — PATCH métadonnées : verrou optimiste, statut/reference non modifiables
  // ---------------------------------------------------------------------------
  it("PATCH /api/v1/affaires/:id updates metadata and returns the fresh optimistic token", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ before: { id: 7, statut: "EN_COURS" }, updated_at_text: "2026-02-02T10:00:00.000Z" }] }) // lock
      .mockResolvedValueOnce({ rows: [{ id: "7", statut: "EN_COURS", updated_at: "2026-02-02T11:00:00.000Z" }] }) // update
      .mockResolvedValueOnce({ rows: [{ id: "audit-1", created_at: "2026-02-01T10:00:00.000Z" }] }) // audit
      .mockResolvedValueOnce({ rows: [] }) // notify
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app)
      .patch("/api/v1/affaires/7")
      .send({ commentaire: "note", expected_updated_at: "2026-02-02T10:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, statut: "EN_COURS", updated_at: "2026-02-02T11:00:00.000Z" });
    const updateCall = mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("UPDATE affaire"));
    expect(String(updateCall?.[0])).not.toContain("statut =");
    expect(String(updateCall?.[0])).not.toContain("reference =");
  });

  it("PATCH /api/v1/affaires/:id returns 409 CONCURRENT_MODIFICATION on a stale token", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ before: { id: 7 }, updated_at_text: "2026-02-02T10:00:00.000Z" }] }) // lock
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await request(app)
      .patch("/api/v1/affaires/7")
      .send({ commentaire: "note", expected_updated_at: "STALE" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONCURRENT_MODIFICATION");
    expect(mocks.clientQuery.mock.calls.some((c) => String(c[0]).includes("UPDATE affaire"))).toBe(false);
    expect(mocks.clientQuery.mock.calls.some((c) => String(c[0]) === "ROLLBACK")).toBe(true);
  });

  it("PATCH /api/v1/affaires/:id ignores statut/reference (immutable) -> 400 No fields", async () => {
    const res = await request(app).patch("/api/v1/affaires/7").send({ statut: "CLOTUREE", reference: "AFF-X" });
    expect(res.status).toBe(400);
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // #169 — machine d'état : transitions valides / interdites / RBAC / concurrence
  // ---------------------------------------------------------------------------
  it("POST /api/v1/affaires/:id/transition performs a legal transition (EN_COURS -> CLOTUREE) and sets date_cloture", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ statut: "EN_COURS", updated_at_text: "2026-02-02T10:00:00.000Z", before: { id: 7, statut: "EN_COURS" } }] }) // lock
      .mockResolvedValueOnce({ rows: [{ id: "7", statut: "CLOTUREE", updated_at: "2026-02-02T12:00:00.000Z" }] }) // update
      .mockResolvedValueOnce({ rows: [{ id: "audit-1", created_at: "2026-02-01T10:00:00.000Z" }] }) // audit
      .mockResolvedValueOnce({ rows: [] }) // notify
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app).post("/api/v1/affaires/7/transition").send({ to: "CLOTUREE" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, statut: "CLOTUREE" });
    const updateCall = mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("UPDATE affaire"));
    expect(String(updateCall?.[0])).toContain("date_cloture = COALESCE(date_cloture, CURRENT_DATE)");
    const auditCall = mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO erp_audit_logs"));
    expect((auditCall?.[1] as unknown[])?.[2]).toBe("affaires.transition.close");
  });

  it("POST /api/v1/affaires/:id/transition rejects an illegal transition (EN_COURS -> OUVERTE) with 422", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ statut: "EN_COURS", updated_at_text: "2026-02-02T10:00:00.000Z", before: { id: 7 } }] }) // lock
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await request(app).post("/api/v1/affaires/7/transition").send({ to: "OUVERTE" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_TRANSITION");
    expect(res.body.details).toMatchObject({ from: "EN_COURS", to: "OUVERTE" });
    expect(mocks.clientQuery.mock.calls.some((c) => String(c[0]).includes("UPDATE affaire"))).toBe(false);
  });

  it("POST /api/v1/affaires/:id/transition requires a reason for ANNULEE (400)", async () => {
    const res = await request(app).post("/api/v1/affaires/7/transition").send({ to: "ANNULEE" });
    expect(res.status).toBe(400);
    expect((res.body.errors as Array<{ field: string }>).some((e) => e.field === "reason")).toBe(true);
  });

  it("POST /api/v1/affaires/:id/transition forbids CLOTURE for a role lacking 'close' (403 at route)", async () => {
    const res = await request(app).post("/api/v1/affaires/7/transition").set("x-test-role", "logistique").send({ to: "CLOTUREE" });
    expect(res.status).toBe(403);
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  it("POST /api/v1/affaires/:id/transition forbids reopen for a role lacking 'reopen' (403 in service)", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ statut: "CLOTUREE", updated_at_text: "2026-02-02T10:00:00.000Z", before: { id: 7 } }] }) // lock
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    // commercial : possède 'transition' (passe le middleware) mais pas 'reopen' -> 403 en service
    const res = await request(app).post("/api/v1/affaires/7/transition").set("x-test-role", "commercial").send({ to: "OUVERTE" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(mocks.clientQuery.mock.calls.some((c) => String(c[0]).includes("UPDATE affaire"))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // #169 — archivage : aucune suppression physique, idempotent, RBAC
  // ---------------------------------------------------------------------------
  it("POST /api/v1/affaires/:id/archive archives without any physical delete", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ statut: "EN_COURS", updated_at_text: "2026-02-02T10:00:00.000Z", before: { id: 7 } }] }) // lock
      .mockResolvedValueOnce({ rows: [{ id: "7", statut: "ANNULEE", updated_at: "2026-02-02T13:00:00.000Z" }] }) // update
      .mockResolvedValueOnce({ rows: [{ id: "audit-1", created_at: "2026-02-01T10:00:00.000Z" }] }) // audit
      .mockResolvedValueOnce({ rows: [] }) // notify
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app).post("/api/v1/affaires/7/archive").send({ reason: "dossier soldé" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, statut: "ANNULEE", already_archived: false });
    expect(mocks.clientQuery.mock.calls.some((c) => String(c[0]).includes("DELETE FROM affaire"))).toBe(false);
    expect(mocks.clientQuery.mock.calls.some((c) => String(c[0]).includes("DELETE FROM commande_to_affaire"))).toBe(false);
  });

  it("POST /api/v1/affaires/:id/archive is idempotent for an already-archived affaire", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ statut: "ANNULEE", updated_at_text: "2026-02-02T10:00:00.000Z", before: { id: 7 } }] }) // lock
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app).post("/api/v1/affaires/7/archive").send({ reason: "again" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ statut: "ANNULEE", already_archived: true });
    expect(mocks.clientQuery.mock.calls.some((c) => String(c[0]).includes("UPDATE affaire"))).toBe(false);
  });

  it("POST /api/v1/affaires/:id/archive is forbidden for a role lacking 'archive' (403)", async () => {
    const res = await request(app).post("/api/v1/affaires/7/archive").set("x-test-role", "logistique").send({ reason: "x" });
    expect(res.status).toBe(403);
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // #169 — aperçu de création manuelle : lecture seule, aucun effet de bord
  // ---------------------------------------------------------------------------
  it("POST /api/v1/affaires/preview returns code format + linked entities with no side effect", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ client_id: "001", company_name: "ACME", email: null, phone: null, delivery_address_id: null, bill_address_id: null }] }) // client
      .mockResolvedValueOnce({ rows: [{ id: "123", numero: "CC-123", client_id: "001", statut: "brouillon" }] }) // commande
      .mockResolvedValueOnce({ rows: [{ n: 0 }] }); // existing affaire count

    const res = await request(app).post("/api/v1/affaires/preview").send({ client_id: "001", commande_id: 123 });

    expect(res.status).toBe(200);
    expect(res.body.code_format).toMatch(/^AFF-\d{4}-NNNN$/);
    expect(res.body.can_create).toBe(true);
    expect(res.body.client).toMatchObject({ company_name: "ACME" });
    expect(res.body.commande).toMatchObject({ id: 123, numero: "CC-123" });
    expect(mocks.poolConnect).not.toHaveBeenCalled(); // aucune transaction, aucun effet de bord
  });

  it("POST /api/v1/affaires/preview flags COMMANDE_NOT_FOUND as a blocker", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ client_id: "001", company_name: "ACME", email: null, phone: null, delivery_address_id: null, bill_address_id: null }] }) // client
      .mockResolvedValueOnce({ rows: [] }); // commande not found

    const res = await request(app).post("/api/v1/affaires/preview").send({ client_id: "001", commande_id: 999 });

    expect(res.status).toBe(200);
    expect(res.body.can_create).toBe(false);
    expect(res.body.blockers).toContain("COMMANDE_NOT_FOUND");
  });
});
