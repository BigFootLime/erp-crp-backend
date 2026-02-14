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

describe("/api/v1/devis", () => {
  it("GET /api/v1/devis returns {items,total} with filters/pagination and include=client", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "7",
            numero: "DV-7",
            client_id: "001",
            date_creation: "2026-02-01T10:00:00.000Z",
            date_validite: "2026-03-01",
            statut: "BROUILLON",
            remise_globale: 0,
            total_ht: 100,
            total_ttc: 120,
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
      });

    const res = await request(app).get("/api/v1/devis").query({
      q: "DV",
      client_id: "001",
      statut: "BROUILLON",
      from: "2026-02-01",
      to: "2026-02-28",
      page: "2",
      pageSize: "5",
      sortBy: "numero",
      sortDir: "asc",
      include: "client",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 1,
      items: [
        {
          id: 7,
          numero: "DV-7",
          client_id: "001",
          total_ttc: 120,
          client: { company_name: "ACME" },
        },
      ],
    });
    expect(typeof res.body.items[0].id).toBe("number");

    const countCall = mocks.poolQuery.mock.calls[0];
    const dataCall = mocks.poolQuery.mock.calls[1];
    expect(String(countCall[0])).toContain("FROM devis d");
    expect(String(countCall[0])).toContain("LEFT JOIN clients c");
    expect(countCall[1]).toEqual(["%DV%", "001", "BROUILLON", "2026-02-01", "2026-02-28"]);

    expect(String(dataCall[0])).toContain("ORDER BY d.numero ASC");
    expect(dataCall[1]).toEqual(["%DV%", "001", "BROUILLON", "2026-02-01", "2026-02-28", 5, 5]);
  });

  it("GET /api/v1/devis/:id returns {devis,lignes,documents} with includes", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "7",
            numero: "DV-7",
            client_id: "001",
            contact_id: null,
            user_id: "1",
            adresse_facturation_id: null,
            adresse_livraison_id: null,
            mode_reglement_id: null,
            compte_vente_id: null,
            date_creation: "2026-02-01T10:00:00.000Z",
            date_validite: "2026-03-01",
            statut: "BROUILLON",
            remise_globale: 0,
            total_ht: 100,
            total_ttc: 120,
            commentaires: null,
            conditions_paiement_id: null,
            biller_id: null,
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
            id: "1",
            devis_id: "7",
            description: "Line",
            quantite: 1,
            unite: "u",
            prix_unitaire_ht: 100,
            remise_ligne: 0,
            taux_tva: 20,
            total_ht: 100,
            total_ttc: 120,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "10",
            devis_id: "7",
            document_id: "11111111-1111-1111-1111-111111111111",
            type: "PDF",
            document: {
              id: "11111111-1111-1111-1111-111111111111",
              document_name: "doc.pdf",
              type: "PDF",
              creation_date: "2026-02-02T10:00:00.000Z",
              created_by: "test",
            },
          },
        ],
      });

    const res = await request(app)
      .get("/api/v1/devis/7")
      .query({ include: "client,lignes,documents,unknown" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("devis");
    expect(res.body).toHaveProperty("lignes");
    expect(res.body).toHaveProperty("documents");
    expect(res.body.devis).toMatchObject({ id: 7, numero: "DV-7", client: { company_name: "ACME" } });
    expect(res.body.lignes[0]).toMatchObject({ id: 1, devis_id: 7, total_ttc: 120 });
    expect(res.body.documents[0]).toMatchObject({
      id: 10,
      devis_id: 7,
      document_id: "11111111-1111-1111-1111-111111111111",
      document: { document_name: "doc.pdf" },
    });

    const docsCall = mocks.poolQuery.mock.calls.find((c) => String(c[0]).includes("FROM devis_documents"));
    expect(String(docsCall?.[0])).toContain("documents_clients");
    expect(String(docsCall?.[0])).not.toMatch(/JOIN\s+documents\b/);
  });

  it("GET /api/v1/devis/:id/documents/:docId/file serves linked document", async () => {
    const docId = "11111111-1111-1111-1111-111111111111";
    const uploadsDir = path.resolve("uploads/docs");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const filePath = path.join(uploadsDir, `${docId}.pdf`);
    fs.writeFileSync(filePath, "hello");

    mocks.poolQuery.mockResolvedValueOnce({
      rows: [{ id: docId, document_name: "doc.pdf", type: "PDF" }],
    });

    const resInline = await request(app).get(`/api/v1/devis/7/documents/${docId}/file`);
    expect(resInline.status).toBe(200);
    expect(resInline.headers["content-type"]).toContain("application/pdf");
    expect(resInline.headers["content-disposition"]).toContain('inline; filename="doc.pdf"');

    mocks.poolQuery.mockResolvedValueOnce({
      rows: [{ id: docId, document_name: "doc.pdf", type: "PDF" }],
    });

    const resDownload = await request(app).get(`/api/v1/devis/7/documents/${docId}/file`).query({ download: "true" });
    expect(resDownload.status).toBe(200);
    expect(resDownload.headers["content-disposition"]).toContain('attachment; filename="doc.pdf"');

    fs.rmSync(filePath, { force: true });
  });

  it("POST /api/v1/devis supports multipart data + optional documents[]", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-crp-devis-"));
    const tmpFile = path.join(tmpDir, "doc.txt");
    fs.writeFileSync(tmpFile, "hello");

    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "7" }] }) // nextval devis_id_seq
      .mockResolvedValueOnce({ rows: [{ id: "7" }] }) // INSERT devis
      .mockResolvedValueOnce({ rows: [] }) // INSERT devis_ligne
      .mockResolvedValueOnce({ rows: [] }) // INSERT documents_clients
      .mockResolvedValueOnce({ rows: [] }) // INSERT devis_documents
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const payload = {
      client_id: "001",
      user_id: 1,
      lignes: [{ description: "Line", quantite: 1, prix_unitaire_ht: 100 }],
    };

    const res = await request(app)
      .post("/api/v1/devis")
      .field("data", JSON.stringify(payload))
      .attach("documents[]", tmpFile);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 7 });
    expect(mocks.poolConnect).toHaveBeenCalledTimes(1);

    const insertDocClientCall = mocks.clientQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO documents_clients")
    );
    expect(insertDocClientCall).toBeTruthy();
    const docId = (insertDocClientCall?.[1] as unknown[])[0];
    expect(typeof docId).toBe("string");
    expect(String(docId)).toMatch(/^[0-9a-fA-F-]{36}$/);

    const insertDevisDocCall = mocks.clientQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO devis_documents")
    );
    expect(insertDevisDocCall).toBeTruthy();
    const docId2 = (insertDevisDocCall?.[1] as unknown[])[1];
    expect(docId2).toBe(docId);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("PATCH /api/v1/devis/:id supports multipart update (replace lignes)", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "7" }] }) // UPDATE devis
      .mockResolvedValueOnce({ rows: [] }) // DELETE devis_ligne
      .mockResolvedValueOnce({ rows: [] }) // INSERT devis_ligne
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const payload = {
      statut: "BROUILLON",
      user_id: 1,
      lignes: [{ description: "Line updated", quantite: 2, prix_unitaire_ht: 50 }],
    };

    const res = await request(app)
      .patch("/api/v1/devis/7")
      .field("data", JSON.stringify(payload));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7 });
    expect(mocks.poolConnect).toHaveBeenCalledTimes(1);

    const deleteLinesCall = mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("DELETE FROM devis_ligne"));
    expect(deleteLinesCall).toBeTruthy();
  });

  it("DELETE /api/v1/devis/:id returns 204", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const res = await request(app).delete("/api/v1/devis/7");
    expect(res.status).toBe(204);

    const sql = String(mocks.poolQuery.mock.calls[0][0]);
    expect(sql).toContain("DELETE FROM devis");
    expect(mocks.poolQuery.mock.calls[0][1]).toEqual([7]);
  });
});
