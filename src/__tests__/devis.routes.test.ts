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
            root_devis_id: "7",
            parent_devis_id: null,
            version_number: 1,
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
            root_devis_id: "7",
            parent_devis_id: null,
            version_number: 1,
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
            article_id: null,
            piece_technique_id: null,
            source_article_devis_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            source_dossier_devis_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            code_piece: "PCT-001",
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
            id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            devis_id: "7",
            devis_ligne_id: "1",
            root_article_devis_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            parent_article_devis_id: null,
            version_number: 1,
            code: "PCT-001",
            designation: "Line",
            primary_category: "piece_finie_fabriquee",
            article_categories: ["piece_finie_fabriquee"],
            family_code: "PT",
            plan_index: 1,
            projet_id: null,
            source_official_article_id: null,
            created_at: "2026-02-02T10:00:00.000Z",
            updated_at: "2026-02-02T10:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            article_devis_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            devis_id: "7",
            root_dossier_devis_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            parent_dossier_devis_id: null,
            version_number: 1,
            code_piece: "PCT-001",
            designation: "Line",
            source_official_piece_technique_id: null,
            payload: {},
            created_at: "2026-02-02T10:00:00.000Z",
            updated_at: "2026-02-02T10:00:00.000Z",
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
    expect(res.body.lignes[0]).toMatchObject({
      id: 1,
      devis_id: 7,
      total_ttc: 120,
      source_article_devis_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      source_dossier_devis_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    });
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

  it("GET /api/v1/devis/:id/commande-draft returns editable commande draft payload", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "7",
            root_devis_id: "7",
            parent_devis_id: null,
            version_number: 1,
            numero: "DV-7",
            client_id: "001",
            contact_id: "11111111-1111-1111-1111-111111111111",
            adresse_facturation_id: "22222222-2222-2222-2222-222222222222",
            adresse_livraison_id: "33333333-3333-3333-3333-333333333333",
            mode_reglement_id: null,
            conditions_paiement_id: 15,
            biller_id: null,
            compte_vente_id: null,
            commentaires: "Depuis devis",
            remise_globale: 5,
            total_ht: 100,
            total_ttc: 120,
            statut: "ACCEPTE",
            updated_at: "2026-03-24T10:00:00.000Z",
            created_at: "2026-03-23T10:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "1",
            description: "Piece A",
            code_piece: "PCT-001",
            quantite: 2,
            unite: "u",
            prix_unitaire_ht: 50,
            remise_ligne: 0,
            taux_tva: 20,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            lookup_code: "PCT-001",
            article_id: "44444444-4444-4444-4444-444444444444",
            piece_technique_id: "55555555-5555-5555-5555-555555555555",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            lookup_code: "PCT-001",
            article_devis_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            article_devis_devis_id: "7",
            article_code: "PCT-001",
            article_designation: "Piece A",
            primary_category: "piece_finie_fabriquee",
            article_categories: ["piece_finie_fabriquee"],
            family_code: "PT",
            plan_index: 1,
            projet_id: null,
            source_official_article_id: null,
            dossier_devis_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            dossier_devis_devis_id: "7",
            dossier_code_piece: "PCT-001",
            dossier_designation: "Piece A",
            source_official_piece_technique_id: null,
            dossier_payload: {},
          },
        ],
      });

    const res = await request(app).get("/api/v1/devis/7/commande-draft");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      devis: {
        id: 7,
        numero: "DV-7",
        client_id: "001",
        updated_at: "2026-03-24T10:00:00.000Z",
      },
      draft: {
        devis_id: 7,
        source_devis_updated_at: "2026-03-24T10:00:00.000Z",
        client_id: "001",
        contact_id: "11111111-1111-1111-1111-111111111111",
        destinataire_id: "33333333-3333-3333-3333-333333333333",
        adresse_facturation_id: "22222222-2222-2222-2222-222222222222",
        commentaire: "Depuis devis",
        lignes: [
          {
            article_id: "44444444-4444-4444-4444-444444444444",
            source_article_devis_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            source_dossier_devis_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            designation: "Piece A",
            code_piece: "PCT-001",
            devis_numero: "DV-7",
          },
        ],
      },
    });

    expect(mocks.clientRelease).toHaveBeenCalled();
  });

  it("GET /api/v1/devis/by-article/:articleId returns related devis with versions", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "12",
          root_devis_id: "7",
          parent_devis_id: "10",
          version_number: 3,
          numero: "DV-7-V3",
          client_id: "001",
          date_creation: "2026-03-20",
          updated_at: "2026-03-21T10:00:00.000Z",
          date_validite: null,
          statut: "BROUILLON",
          remise_globale: 0,
          total_ht: 100,
          total_ttc: 120,
          client: null,
        },
      ],
    });

    const res = await request(app).get("/api/v1/devis/by-article/11111111-1111-1111-1111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 1,
      items: [
        {
          id: 12,
          root_devis_id: 7,
          parent_devis_id: 10,
          version_number: 3,
          numero: "DV-7-V3",
        },
      ],
    });
  });

  it("GET /api/v1/devis/by-article-devis-code/:code returns related devis versions", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "18",
          root_devis_id: "7",
          parent_devis_id: "12",
          version_number: 4,
          numero: "DV-7-V4",
          client_id: "001",
          date_creation: "2026-03-20",
          updated_at: "2026-03-26T10:00:00.000Z",
          date_validite: null,
          statut: "ACCEPTE",
          remise_globale: 0,
          total_ht: 100,
          total_ttc: 120,
          client: null,
        },
      ],
    });

    const res = await request(app).get("/api/v1/devis/by-article-devis-code/PCT-001");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 1,
      items: [
        {
          id: 18,
          root_devis_id: 7,
          parent_devis_id: 12,
          version_number: 4,
          numero: "DV-7-V4",
        },
      ],
    });
  });

  it("GET /api/v1/devis/:id/documents/:docId/file serves linked document", async () => {
    const docId = "33333333-3333-3333-3333-333333333333";
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
      .mockResolvedValueOnce({ rows: [{ id: "1" }] }) // INSERT devis_ligne (RETURNING id)
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
      .mockResolvedValueOnce({ rows: [] }) // DELETE dossier_technique_piece_devis
      .mockResolvedValueOnce({ rows: [] }) // DELETE article_devis
      .mockResolvedValueOnce({ rows: [] }) // DELETE devis_ligne
      .mockResolvedValueOnce({ rows: [{ id: "1" }] }) // INSERT devis_ligne (RETURNING id)
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

  it("POST /api/v1/devis/:id/revise clones devis into a new version", async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          {
            id: "7",
            root_devis_id: "7",
            numero: "DV-7",
            client_id: "001",
            contact_id: null,
            adresse_facturation_id: null,
            adresse_livraison_id: null,
            mode_reglement_id: null,
            compte_vente_id: null,
            date_validite: null,
            statut: "BROUILLON",
            remise_globale: 0,
            total_ht: 100,
            total_ttc: 120,
            commentaires: null,
            conditions_paiement_id: null,
            biller_id: null,
          },
        ],
      }) // source devis
      .mockResolvedValueOnce({ rows: [{ next_version: 2 }] }) // next version
      .mockResolvedValueOnce({ rows: [{ id: "8" }] }) // nextval devis_id_seq
      .mockResolvedValueOnce({ rows: [{ id: "8" }] }) // insert new devis
      .mockResolvedValueOnce({ rows: [] }) // copy lignes
      .mockResolvedValueOnce({ rows: [] }) // source article_devis to clone
      .mockResolvedValueOnce({ rows: [] }) // copy documents
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const res = await request(app)
      .post("/api/v1/devis/7/revise")
      .field("data", JSON.stringify({ user_id: 1 }));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 8, root_devis_id: 7, parent_devis_id: 7, version_number: 2 });
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
