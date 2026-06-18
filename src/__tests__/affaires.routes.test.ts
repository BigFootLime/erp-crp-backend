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

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; username: string; email: string; role: string } }, _res: unknown, next: () => void) => {
    req.user = {
      id: 1,
      username: "test-admin",
      email: "admin@example.test",
      role: "administrateur",
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

  it("POST /api/v1/affaires generates reference when missing and returns {id}", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "7" }] }) // nextval
      .mockResolvedValueOnce({ rows: [{ id: "7" }] }) // INSERT
      .mockResolvedValueOnce({ rows: [{ id: "audit-1", created_at: "2026-02-01T10:00:00.000Z" }] }) // audit
      .mockResolvedValueOnce({ rows: [] }) // notify
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app).post("/api/v1/affaires").send({ client_id: "001" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 7 });
    expect(mocks.poolConnect).toHaveBeenCalledTimes(1);

    const insertCall = mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO affaire"));
    expect(insertCall).toBeTruthy();
    const params = insertCall?.[1] as unknown[];
    expect(params[0]).toBe(7);
    expect(params[1]).toBe("AFF-7");
  });

  it("POST /api/v1/affaires returns 409 on duplicate reference", async () => {
    const dup = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint: "affaire_reference_key",
    });

    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "8" }] }) // nextval
      .mockImplementationOnce(() => {
        throw dup;
      }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await request(app)
      .post("/api/v1/affaires")
      .send({ reference: "AFF-1", client_id: "001" });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty("message");
    expect(String(res.body.message)).toContain("Reference");
    expect(mocks.clientQuery.mock.calls.some((c) => String(c[0]) === "ROLLBACK")).toBe(true);
  });

  it("PATCH /api/v1/affaires/:id sets date_cloture when statut=CLOTUREE and missing date_cloture", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ before: { id: 7, statut: "EN_COURS" } }] }) // lock before
      .mockResolvedValueOnce({ rows: [{ id: "7" }] }) // update
      .mockResolvedValueOnce({ rows: [{ id: "audit-1", created_at: "2026-02-01T10:00:00.000Z" }] }) // audit
      .mockResolvedValueOnce({ rows: [] }) // notify
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app).patch("/api/v1/affaires/7").send({ statut: "CLOTUREE" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7 });

    const updateCall = mocks.clientQuery.mock.calls[2];
    expect(String(updateCall[0])).toContain("UPDATE affaire");
    expect(String(updateCall[0])).toContain("date_cloture = COALESCE(date_cloture, CURRENT_DATE)");
    expect(updateCall[1]).toEqual([7, "CLOTUREE"]);
  });

  it("DELETE /api/v1/affaires/:id deletes successfully", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ before: { id: 7, reference: "AFF-7" } }] }) // lock before
      .mockResolvedValueOnce({ rows: [{ count: 1 }] }) // mapping count
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // delete links
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // delete affaire
      .mockResolvedValueOnce({ rows: [{ id: "audit-1", created_at: "2026-02-01T10:00:00.000Z" }] }) // audit
      .mockResolvedValueOnce({ rows: [] }) // notify
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app).delete("/api/v1/affaires/7");
    expect(res.status).toBe(204);

    expect(String(mocks.clientQuery.mock.calls[3][0])).toContain("DELETE FROM commande_to_affaire");
    expect(String(mocks.clientQuery.mock.calls[4][0])).toContain("DELETE FROM affaire");
  });
});
