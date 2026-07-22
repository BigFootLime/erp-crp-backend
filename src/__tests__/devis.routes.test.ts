import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDocumentStoragePath } from "../utils/cerpStorage";

process.env.CERP_DOCUMENTS_ROOT = path.resolve("uploads", "docs");

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

// Auth mock : rôle injectable via l'en-tête `x-test-role` (défaut : administrateur).
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

import app from "../config/app";

/**
 * Mock pg robuste par CONTENU de requête (pattern #172) : chaque test configure `state`,
 * le dispatcher répond selon le SQL — insensible à l'ordre exact des requêtes internes
 * (probes information_schema, audit transactionnel, idempotence…).
 */
const defaultState = () => ({
  // Colonnes optionnelles sondées par hasPublicColumn (code_piece legacy absent par défaut).
  columns: { code_piece: false, position: true, total_ht: true, total_ttc: true } as Record<string, boolean>,
  idempotenceTable: true,
  idemRow: null as null | { action: string; payload_hash: string; resultat: Record<string, unknown> },
  listTotal: 1,
  listRows: [] as Record<string, unknown>[],
  detailHeader: null as null | Record<string, unknown>,
  detailLines: [] as Record<string, unknown>[],
  articleDevisRows: [] as Record<string, unknown>[],
  dossierDevisRows: [] as Record<string, unknown>[],
  documentRows: [] as Record<string, unknown>[],
  flags: { has_children: false, commande_id: null as string | null, commande_numero: null as string | null },
  commandeHeader: null as null | Record<string, unknown>,
  draftLines: [] as Record<string, unknown>[],
  draftArticlesByCode: [] as Record<string, unknown>[],
  draftPreparatoryByCode: [] as Record<string, unknown>[],
  updateCurrent: null as null | Record<string, unknown>,
  deleteCurrent: null as null | Record<string, unknown>,
  existingCommande: null as null | { id: string; numero: string },
  hasPrep: false,
  nextVersion: 2,
  devisSeqId: "7",
  insertDevisReturnId: "7",
  ligneSeq: 1,
  convertLineCount: 1,
  docFileMeta: [] as Record<string, unknown>[],
});

let state = defaultState();

function dispatch(sqlRaw: unknown, params?: unknown[]): { rows: unknown[]; rowCount?: number } {
  const sql = String(sqlRaw);

  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [] };

  if (/information_schema\.columns/.test(sql)) {
    const column = String(params?.[1] ?? "");
    return { rows: [{ exists: state.columns[column] === true }] };
  }
  if (/information_schema\.tables/.test(sql)) return { rows: [{ exists: state.idempotenceTable }] };

  if (/FROM public\.devis_idempotence WHERE cle/.test(sql)) return { rows: state.idemRow ? [state.idemRow] : [] };
  if (/INSERT INTO public\.devis_idempotence/.test(sql)) return { rows: [] };

  if (/erp_audit_logs/i.test(sql)) return { rows: [{ id: "99", created_at: "2026-07-22T08:00:00.000Z" }] };
  if (/pg_notify/i.test(sql)) return { rows: [] };

  // Écritures AVANT les matchers de lecture : les INSERT…SELECT contiennent aussi
  // des fragments de SELECT (FROM devis_ligne dl, source_article_devis_id…).
  if (/INSERT INTO devis_ligne/.test(sql)) {
    const id = String(state.ligneSeq);
    state.ligneSeq += 1;
    return { rows: [{ id }], rowCount: 1 };
  }
  if (/INSERT INTO devis_documents/.test(sql)) return { rows: [] };
  if (/INSERT INTO documents_clients/.test(sql)) return { rows: [] };
  if (/INSERT INTO commande_ligne/.test(sql)) return { rows: [], rowCount: state.convertLineCount };
  if (/INSERT INTO commande_client/.test(sql)) return { rows: [] };
  if (/INSERT INTO devis\s*\(/.test(sql)) return { rows: [{ id: state.insertDevisReturnId }] };
  if (/INSERT INTO (public\.)?(article_devis|dossier_technique_piece_devis)/.test(sql)) {
    return { rows: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }] };
  }
  if (/UPDATE public\.articles/.test(sql)) return { rows: [] };
  if (/UPDATE devis\s+SET/i.test(sql)) return { rows: [{ id: "7" }], rowCount: 1 };
  if (/DELETE FROM (public\.)?(devis_ligne|article_devis|dossier_technique_piece_devis)/.test(sql)) {
    return { rows: [], rowCount: 1 };
  }
  if (/DELETE FROM devis/.test(sql)) return { rows: [], rowCount: 1 };

  if (/devis_id_seq/.test(sql)) return { rows: [{ id: state.devisSeqId }] };
  if (/commande_client_id_seq/.test(sql)) return { rows: [{ id: "55" }] };
  if (/fn_next(_issued)?_code_value/.test(sql)) return { rows: [{ v: "1" }] };

  if (/MAX\(version_number\)/i.test(sql)) return { rows: [{ next_version: state.nextVersion }] };

  // Ligne courante verrouillée : suppression (AS converted) / mise à jour (FOR UPDATE OF d).
  if (/AS converted/.test(sql)) return { rows: state.deleteCurrent ? [state.deleteCurrent] : [] };
  if (/FOR UPDATE OF d/.test(sql)) return { rows: state.updateCurrent ? [state.updateCurrent] : [] };

  // Source d'une révision (FROM devis sans alias).
  if (/FROM devis\s+WHERE id = \$1\s+FOR UPDATE/.test(sql)) {
    return { rows: state.commandeHeader ? [state.commandeHeader] : [] };
  }
  // En-tête conversion / commande-draft (alias d + created_at JSONB).
  if (/->>'created_at'/.test(sql) && /FROM devis d/.test(sql)) {
    return { rows: state.commandeHeader ? [state.commandeHeader] : [] };
  }

  if (/AS has_children/.test(sql)) {
    return { rows: [{ has_children: state.flags.has_children, commande_id: state.flags.commande_id, commande_numero: state.flags.commande_numero }] };
  }
  if (/AS has_prep/.test(sql)) return { rows: [{ has_prep: state.hasPrep }] };
  if (/FROM commande_client cc\s+WHERE cc\.devis_id/.test(sql)) {
    return { rows: state.existingCommande ? [state.existingCommande] : [] };
  }

  if (/AS article_devis_devis_id/.test(sql)) return { rows: state.draftPreparatoryByCode };
  // Recherches transverses par article / code article-devis (avant les matchers génériques).
  if (/FROM public\.devis_ligne dl/.test(sql) && /JOIN public\.devis d/.test(sql)) return { rows: state.listRows };
  if (/FROM public\.article_devis ad/.test(sql) && /JOIN public\.devis d/.test(sql)) return { rows: state.listRows };
  if (/to_jsonb\(ad\)/.test(sql)) return { rows: state.articleDevisRows };
  if (/to_jsonb\(dd\)/.test(sql)) return { rows: state.dossierDevisRows };
  if (/lookup\.lookup_code/.test(sql) && /JOIN public\.articles/.test(sql)) {
    return { rows: state.draftArticlesByCode };
  }

  if (/AS position/.test(sql) && /FROM devis_ligne dl/.test(sql)) return { rows: state.detailLines };
  if (/FROM devis_ligne dl/.test(sql) && /source_article_devis_id/.test(sql)) return { rows: state.draftLines };
  if (/SELECT quantite/.test(sql) && /FROM devis_ligne/.test(sql)) return { rows: [] };

  if (/jsonb_build_object/.test(sql) && /FROM devis_documents/.test(sql)) return { rows: state.documentRows };
  if (/JOIN documents_clients dc/.test(sql) && /dd\.document_id = \$2/.test(sql)) return { rows: state.docFileMeta };

  if (/count\(\*\)/i.test(sql) && /FROM devis d/.test(sql)) return { rows: [{ total: state.listTotal }] };
  // En-tête détail (WHERE d.id = $1, pas de verrou) — AVANT le fallback liste.
  if (/WHERE d\.id = \$1/.test(sql) && /AS parent_devis_id/.test(sql)) {
    return { rows: state.detailHeader ? [state.detailHeader] : [] };
  }
  if (/FROM devis d/.test(sql)) return { rows: state.listRows };

  return { rows: [] };
}

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
  state = defaultState();
  mocks.poolQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => dispatch(sql, params));
  mocks.clientQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => dispatch(sql, params));
});

describe("/api/v1/devis", () => {
  it("GET /api/v1/devis returns {items,total} with filters/pagination and include=client", async () => {
    state.listRows = [
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
    ];

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
    state.detailHeader = {
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
      updated_at: "2026-02-02T10:00:00.000Z",
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
    };
    state.detailLines = [
      {
        id: "1",
        devis_id: "7",
        article_id: null,
        piece_technique_id: null,
        source_article_devis_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        source_dossier_devis_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        code_piece: "PCT-001",
        position: 1,
        description: "Line",
        quantite: 1,
        unite: "u",
        prix_unitaire_ht: 100,
        remise_ligne: 0,
        taux_tva: 20,
        total_ht: 100,
        total_ttc: 120,
      },
    ];
    state.articleDevisRows = [
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
    ];
    state.dossierDevisRows = [
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
    ];
    state.documentRows = [
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
    ];

    const res = await request(app)
      .get("/api/v1/devis/7")
      .query({ include: "client,lignes,documents,unknown" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("devis");
    expect(res.body).toHaveProperty("lignes");
    expect(res.body).toHaveProperty("documents");
    expect(res.body.devis).toMatchObject({ id: 7, numero: "DV-7", client: { company_name: "ACME" } });
    // #167 : le serveur expose l'automate et l'état de conversion — l'UI ne les invente pas.
    expect(res.body.devis.allowed_statut_transitions).toEqual(["ENVOYE", "ANNULE"]);
    expect(res.body.devis).toMatchObject({ has_children: false, converted_commande: null });
    expect(res.body.lignes[0]).toMatchObject({
      id: 1,
      devis_id: 7,
      position: 1,
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

    // L'ordre des lignes suit la position persistée.
    const linesCall = mocks.poolQuery.mock.calls.find(
      (c) => String(c[0]).includes("FROM devis_ligne dl") && String(c[0]).includes("AS position")
    );
    expect(String(linesCall?.[0])).toContain("dl.position ASC NULLS LAST");
  });

  it("GET /api/v1/devis/:id/commande-draft returns editable commande draft payload", async () => {
    state.commandeHeader = {
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
    };
    state.draftLines = [
      {
        id: "1",
        description: "Piece A",
        article_id: null,
        piece_technique_id: null,
        source_article_devis_id: null,
        source_dossier_devis_id: null,
        code_piece: "PCT-001",
        quantite: 2,
        unite: "u",
        prix_unitaire_ht: 50,
        remise_ligne: 0,
        taux_tva: 20,
      },
    ];
    state.draftArticlesByCode = [
      {
        lookup_code: "PCT-001",
        article_id: "44444444-4444-4444-4444-444444444444",
        piece_technique_id: "55555555-5555-5555-5555-555555555555",
      },
    ];
    state.draftPreparatoryByCode = [
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
    ];

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

    const headerSql = String(
      mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("FROM devis d"))?.[0] ?? ""
    );
    expect(headerSql).toContain("d.id::text AS id");
    expect(headerSql).toContain("WHERE d.id = $1");

    const linesSql = String(
      mocks.clientQuery.mock.calls.find(
        (c) => String(c[0]).includes("FROM devis_ligne dl") && String(c[0]).includes("source_article_devis_id")
      )?.[0] ?? ""
    );
    expect(linesSql).toContain("dl.id::text AS id");
    expect(linesSql).not.toMatch(/^\s*id::text AS id/m);
  });

  it("POST /api/v1/devis/:id/convert-to-commande creates commande and lines from accepted devis", async () => {
    state.commandeHeader = {
      id: "7",
      numero: "DV-7",
      client_id: "001",
      contact_id: null,
      adresse_facturation_id: null,
      adresse_livraison_id: "33333333-3333-3333-3333-333333333333",
      mode_reglement_id: null,
      conditions_paiement_id: 15,
      biller_id: null,
      compte_vente_id: null,
      commentaires: "Depuis devis",
      remise_globale: 0,
      total_ht: 100,
      total_ttc: 120,
      statut: "ACCEPTE",
      updated_at: "2026-03-24T10:00:00.000Z",
      created_at: "2026-03-23T10:00:00.000Z",
    };

    const res = await request(app).post("/api/v1/devis/7/convert-to-commande");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 55,
      numero: "CMD-2026-0001",
      devis_id: 7,
      already_converted: false,
      idempotent_replay: false,
    });

    const existingSql = String(
      mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("FROM commande_client cc"))?.[0] ?? ""
    );
    expect(existingSql).toContain("cc.id::text AS id");
    expect(existingSql).toContain("WHERE cc.devis_id = $1");

    const insertCommandeSql = String(
      mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO commande_client"))?.[0] ?? ""
    );
    expect(insertCommandeSql).toContain("source_devis_version_id");

    const insertLinesSql = String(
      mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO commande_ligne"))?.[0] ?? ""
    );
    expect(insertLinesSql).toContain("ad.id");
    expect(insertLinesSql).toContain("dd.id");
    expect(insertLinesSql).toContain("dl.position ASC NULLS LAST");
    expect(insertLinesSql).not.toMatch(/^\s*id\b/m);

    // Conversion auditée dans la transaction.
    const auditSql = mocks.clientQuery.mock.calls.find((c) => /erp_audit_logs/i.test(String(c[0])));
    expect(auditSql).toBeTruthy();
  });

  it("GET /api/v1/devis/by-article/:articleId returns related devis with versions", async () => {
    state.listRows = [
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
    ];

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
    state.listRows = [
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
    ];

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
    const uploadsDir = getDocumentStoragePath();
    fs.mkdirSync(uploadsDir, { recursive: true });
    const filePath = path.join(uploadsDir, `${docId}.pdf`);
    fs.writeFileSync(filePath, "hello");

    state.docFileMeta = [{ id: docId, document_name: "doc.pdf", type: "PDF" }];

    const resInline = await request(app).get(`/api/v1/devis/7/documents/${docId}/file`);
    expect(resInline.status).toBe(200);
    expect(resInline.headers["content-type"]).toContain("application/pdf");
    expect(resInline.headers["content-disposition"]).toContain('inline; filename="doc.pdf"');

    const resDownload = await request(app).get(`/api/v1/devis/7/documents/${docId}/file`).query({ download: "true" });
    expect(resDownload.status).toBe(200);
    expect(resDownload.headers["content-disposition"]).toContain('attachment; filename="doc.pdf"');

    fs.rmSync(filePath, { force: true });
  });

  it("POST /api/v1/devis supports multipart data + optional documents[]", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cerp-devis-"));
    const tmpFile = path.join(tmpDir, "doc.txt");
    fs.writeFileSync(tmpFile, "hello");

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
    expect(res.body).toMatchObject({ id: 7, idempotent_replay: false });
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

    // #167 : la position est écrite avec la ligne (ordre du payload).
    const insertLigneCall = mocks.clientQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO devis_ligne"));
    expect(String(insertLigneCall?.[0])).toContain("position");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("PATCH /api/v1/devis/:id supports multipart update (replace lignes)", async () => {
    state.updateCurrent = {
      id: "7",
      numero: "DV-7",
      statut: "BROUILLON",
      remise_globale: 0,
      updated_at: "2026-03-24T10:00:00.000Z",
      has_children: false,
    };

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

    // Totaux recalculés serveur : jamais les totaux du client.
    const updateSql = String(mocks.clientQuery.mock.calls.find((c) => /UPDATE devis\s+SET/i.test(String(c[0])))?.[0]);
    expect(updateSql).toContain("total_ht");
  });

  it("POST /api/v1/devis/:id/revise clones devis into a new version", async () => {
    state.commandeHeader = {
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
      updated_at: "2026-03-24T10:00:00.000Z",
    };
    state.devisSeqId = "8";
    state.insertDevisReturnId = "8";

    const res = await request(app)
      .post("/api/v1/devis/7/revise")
      .field("data", JSON.stringify({ user_id: 1 }));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 8, root_devis_id: 7, parent_devis_id: 7, version_number: 2 });

    // Le clone conserve l'ordre persisté des lignes.
    const cloneSql = String(
      mocks.clientQuery.mock.calls.find(
        (c) => String(c[0]).includes("INSERT INTO devis_ligne") && String(c[0]).includes("SELECT")
      )?.[0] ?? ""
    );
    expect(cloneSql).toContain("dl.position");
  });

  it("DELETE /api/v1/devis/:id returns 204", async () => {
    state.deleteCurrent = { numero: "DV-7", statut: "BROUILLON", has_children: false, converted: false };

    const res = await request(app).delete("/api/v1/devis/7");
    expect(res.status).toBe(204);

    const deleteCall = mocks.clientQuery.mock.calls.find((c) => /DELETE FROM devis\b/.test(String(c[0])));
    expect(deleteCall).toBeTruthy();
    expect(deleteCall?.[1]).toEqual([7]);
  });
});
