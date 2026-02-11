import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

describe("/api/v1/commandes", () => {
  it("GET /api/v1/commandes returns {items,total} and applies filters", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
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
            statut: "valide",
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

    const res = await request(app).get("/api/v1/commandes").query({
      q: "ACME",
      client_id: "001",
      statut: "valide",
      from: "2026-02-01",
      to: "2026-02-28",
      min_total_ttc: "10",
      max_total_ttc: "200",
      mine_recent: "true",
      page: "2",
      pageSize: "5",
      sortBy: "numero",
      sortDir: "asc",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 1,
      items: [
        {
          id: "123",
          numero: "CC-123",
          client_id: "001",
          total_ttc: 120,
        },
      ],
    });

    expect(mocks.poolQuery).toHaveBeenCalledTimes(2);

    const countCall = mocks.poolQuery.mock.calls[0];
    const dataCall = mocks.poolQuery.mock.calls[1];

    expect(String(countCall[0])).toContain("FROM commande_client");
    expect(Array.isArray(countCall[1])).toBe(true);
    expect(countCall[1]).toEqual(["%ACME%", "001", "valide", "2026-02-01", "2026-02-28", 10, 200]);

    expect(String(dataCall[0])).toContain("ORDER BY cc.numero ASC");
    expect(dataCall[1]).toEqual(["%ACME%", "001", "valide", "2026-02-01", "2026-02-28", 10, 200, 5, 5]);
  });

  it("GET /api/v1/commandes/:id returns include structures", async () => {
    mocks.poolQuery
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
      .mockResolvedValueOnce({ rows: [{ id: "1" }] }) // lignes
      .mockResolvedValueOnce({ rows: [{ id: "2" }] }) // echeances
      .mockResolvedValueOnce({ rows: [{ id: "3" }] }) // documents
      .mockResolvedValueOnce({ rows: [{ id: "4" }] }) // historique
      .mockResolvedValueOnce({ rows: [{ id: "5" }] }) // affaires
      .mockResolvedValueOnce({
        rows: [
          {
            client_id: "001",
            company_name: "ACME",
            email: null,
            phone: null,
            delivery_address_id: null,
            bill_address_id: null,
          },
        ],
      });

    const res = await request(app).get(
      "/api/v1/commandes/123?include=lignes,echeances,documents,historique,affaires,client"
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("commande");
    expect(res.body).toHaveProperty("lignes");
    expect(res.body).toHaveProperty("echeances");
    expect(res.body).toHaveProperty("documents");
    expect(res.body).toHaveProperty("historique");
    expect(res.body).toHaveProperty("affaires");
    expect(res.body).toHaveProperty("client");
    expect(res.body.commande).toMatchObject({ id: "123", numero: "CC-123" });
  });

  it("POST /api/v1/commandes handles multipart data + documents[]", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-crp-docs-"));
    const tmpFile = path.join(tmpDir, "doc.txt");
    fs.writeFileSync(tmpFile, "hello");

    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "123" }] }) // INSERT commande_client
      .mockResolvedValueOnce({ rows: [] }) // INSERT commande_ligne
      .mockResolvedValueOnce({ rows: [{ id: "doc-uuid" }] }) // INSERT documents
      .mockResolvedValueOnce({ rows: [] }) // INSERT commande_documents
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const payload = {
      numero: "CC-123",
      client_id: "001",
      date_commande: "2026-02-01",
      lignes: [
        {
          designation: "Line",
          quantite: 1,
          prix_unitaire_ht: 100,
        },
      ],
    };

    const res = await request(app)
      .post("/api/v1/commandes")
      .field("data", JSON.stringify(payload))
      .attach("documents[]", tmpFile);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "123" });
    expect(mocks.poolConnect).toHaveBeenCalledTimes(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("POST /api/v1/commandes/:id/status writes historique", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "123" }] }) // exists
      .mockResolvedValueOnce({ rows: [{ nouveau_statut: "brouillon" }] }) // last
      .mockResolvedValueOnce({ rows: [{ id: "10" }] }) // insert historique
      .mockResolvedValueOnce({ rows: [] }) // update commande
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app)
      .post("/api/v1/commandes/123/status")
      .send({ nouveau_statut: "valide", commentaire: "ok" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, nouveau_statut: "valide" });

    const insertCall = mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO commande_historique"));
    expect(insertCall).toBeTruthy();
    expect(insertCall?.[1]).toEqual(["123", null, "brouillon", "valide", "ok"]);
  });

  it("POST /api/v1/commandes/:id/duplicate returns new id", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          {
            numero: "CC-123",
            client_id: "001",
            contact_id: null,
            destinataire_id: null,
            emetteur: null,
            code_client: null,
            compteur_affaire_id: null,
            type_affaire: "fabrication",
            mode_port_id: null,
            mode_reglement_id: null,
            conditions_paiement_id: null,
            biller_id: null,
            compte_vente_id: null,
            commentaire: null,
            remise_globale: 0,
            total_ht: 0,
            total_ttc: 0,
          },
        ],
      }) // original
      .mockResolvedValueOnce({
        rows: [
          {
            designation: "Line",
            code_piece: null,
            quantite: 1,
            unite: "u",
            prix_unitaire_ht: 100,
            remise_ligne: 0,
            taux_tva: 20,
            delai_client: null,
            delai_interne: null,
            devis_numero: null,
            famille: null,
          },
        ],
      }) // lignes
      .mockResolvedValueOnce({ rows: [{ id: "456" }] }) // nextval
      .mockResolvedValueOnce({ rows: [] }) // insert commande
      .mockResolvedValueOnce({ rows: [] }) // insert lignes
      .mockResolvedValueOnce({ rows: [] }) // insert historique
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app).post("/api/v1/commandes/123/duplicate");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "456" });
  });
});
