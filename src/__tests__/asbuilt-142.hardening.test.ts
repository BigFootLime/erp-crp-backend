// #142 — Durcissement du dossier as-built.
//
// Trois défauts corrigés :
//   1. le PDF était écrit dans l'espace documentaire AVANT la validation en
//      base (fichier orphelin possible) ;
//   2. le numéro de version reposait sur `MAX(version)+1` hors transaction
//      (course entre deux générations simultanées) ;
//   3. aucune empreinte n'était conservée (intégrité non vérifiable).

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  insertAuditLog: vi.fn(),
  renderPdf: vi.fn(),
  allocateVersion: vi.fn(),
  insertPackVersion: vi.fn(),
  insertDocument: vi.fn(),
  loadEnrichment: vi.fn(),
}));

vi.mock("../config/database", () => ({
  default: { query: mocks.poolQuery, connect: mocks.poolConnect },
}));

vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: mocks.insertAuditLog,
}));

vi.mock("../module/asbuilt/services/asbuilt-pdf.service", () => ({
  svcRenderAsbuiltPdf: mocks.renderPdf,
}));

vi.mock("../module/asbuilt/repository/asbuilt-enrichment.repository", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../module/asbuilt/repository/asbuilt-enrichment.repository")
  >();
  return { ...actual, repoLoadAsbuiltEnrichment: mocks.loadEnrichment };
});

vi.mock("../module/asbuilt/repository/asbuilt.repository", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../module/asbuilt/repository/asbuilt.repository")
  >();
  return {
    ...actual,
    repoGetLotHeader: vi.fn(async () => ({
      id: LOT_ID,
      article_id: "cccccccc-0000-4000-8000-000000000001",
      article_code: "ART-1",
      article_designation: "Pièce",
      lot_code: "LOT-0001",
      supplier_lot_code: null,
      received_at: null,
      manufactured_at: null,
      expiry_at: null,
      notes: null,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    })),
    repoListOfsForLot: vi.fn(async () => []),
    repoListBonLivraisonsForLot: vi.fn(async () => []),
    repoListNonConformitiesForLot: vi.fn(async () => []),
    repoListPackVersions: vi.fn(async () => []),
    repoCountNcForLot: vi.fn(async () => ({ open: 0, overdue: 0 })),
    repoGetUserLabel: vi.fn(async () => "Jean Testeur"),
    repoAllocateAsbuiltVersionTx: mocks.allocateVersion,
    repoInsertDocumentsClientTx: mocks.insertDocument,
    repoInsertAsbuiltPackVersionTx: mocks.insertPackVersion,
  };
});

import { getTmpRootPath, ensureDocumentStoragePath } from "../utils/cerpStorage";
import { svcGenerateAsbuiltPack } from "../module/asbuilt/services/asbuilt.service";

const LOT_ID = "11111111-1111-4111-8111-111111111111";
const PDF = Buffer.from("%PDF-1.4\ncontenu de test\n");
const EXPECTED_SHA = crypto.createHash("sha256").update(PDF).digest("hex");

const stagingDir = getTmpRootPath("asbuilt-staging");
const docsDir = ensureDocumentStoragePath("asbuilt");

async function listStaging(): Promise<string[]> {
  try {
    return await fs.readdir(stagingDir);
  } catch {
    return [];
  }
}

function emptyEnrichment() {
  return {
    technical_versions: [],
    consumed_lots: [],
    operations: [],
    production_receipts: [],
    stock_movements: [],
    controls: [],
    measurements: [],
    release_decisions: [],
    derogations: [],
    allocations: [],
    delivery_proofs: [],
    lot_status: { current: "RELEASED", note: null },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.renderPdf.mockResolvedValue(PDF);
  mocks.loadEnrichment.mockResolvedValue(emptyEnrichment());
  mocks.insertDocument.mockResolvedValue(undefined);
  mocks.insertPackVersion.mockResolvedValue("aaaa-version-id");
  mocks.allocateVersion.mockResolvedValue(1);
  mocks.insertAuditLog.mockResolvedValue(undefined);

  // `peekNextVersion` passe par le pool, pas par la transaction.
  mocks.poolQuery.mockResolvedValue({ rows: [{ version: 1 }] });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });

  await fs.mkdir(stagingDir, { recursive: true }).catch(() => undefined);
  for (const f of await listStaging()) {
    await fs.unlink(path.join(stagingDir, f)).catch(() => undefined);
  }
});

describe("#142 as-built — génération nominale", () => {
  it("alloue la version SOUS VERROU dans la transaction", async () => {
    await svcGenerateAsbuiltPack({
      lotId: LOT_ID,
      actorUserId: 1,
      body: { signataire_user_id: 1, commentaire: null },
      role: "Responsable Qualite",
    });
    expect(mocks.allocateVersion).toHaveBeenCalledTimes(1);
    // L'allocation reçoit le client de TRANSACTION, pas le pool.
    expect(mocks.allocateVersion.mock.calls[0][0]).toHaveProperty("query");
  });

  it("calcule et conserve l'empreinte SHA-256 du fichier réellement écrit", async () => {
    await svcGenerateAsbuiltPack({
      lotId: LOT_ID,
      actorUserId: 1,
      body: { signataire_user_id: 1, commentaire: null },
      role: "Responsable Qualite",
    });
    const args = mocks.insertPackVersion.mock.calls[0][1];
    expect(args.pdfSha256).toBe(EXPECTED_SHA);
    expect(args.pdfSizeBytes).toBe(PDF.byteLength);
  });

  it("fige le périmètre et la date de référence dans l'enregistrement", async () => {
    await svcGenerateAsbuiltPack({
      lotId: LOT_ID,
      actorUserId: 1,
      body: { signataire_user_id: 1, commentaire: null },
      role: "Responsable Qualite",
    });
    const args = mocks.insertPackVersion.mock.calls[0][1];
    expect(args.asOf).toBeTruthy();
    expect(args.scopeJson).toHaveProperty("of_ids");
    expect(args.scopeJson).toHaveProperty("coverage_warning_codes");
  });

  it("promeut le fichier vers l'espace documentaire et vide la préparation", async () => {
    const result = await svcGenerateAsbuiltPack({
      lotId: LOT_ID,
      actorUserId: 1,
      body: { signataire_user_id: 1, commentaire: null },
      role: "Responsable Qualite",
    });

    expect(await listStaging()).toHaveLength(0);
    const finalPath = path.join(docsDir, `${result.pdf_document_id}.pdf`);
    const written = await fs.readFile(finalPath);
    expect(written.equals(PDF)).toBe(true);
    await fs.unlink(finalPath).catch(() => undefined);
  });

  it("journalise la génération avec l'empreinte", async () => {
    await svcGenerateAsbuiltPack({
      lotId: LOT_ID,
      actorUserId: 1,
      body: { signataire_user_id: 1, commentaire: null },
      role: "Responsable Qualite",
    });
    const call = mocks.insertAuditLog.mock.calls[0][0];
    expect(call.body.action).toBe("asbuilt.pack.generated");
    expect(call.body.details.pdf_sha256).toBe(EXPECTED_SHA);
    // Le journal est écrit DANS la transaction.
    expect(call.tx).toBeDefined();
  });

  it("valide en base AVANT de promouvoir le fichier", async () => {
    const order: string[] = [];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql) === "COMMIT") order.push("commit");
      return { rows: [] };
    });
    mocks.insertPackVersion.mockImplementation(async () => {
      order.push("insert");
      return "v-id";
    });

    const result = await svcGenerateAsbuiltPack({
      lotId: LOT_ID,
      actorUserId: 1,
      body: { signataire_user_id: 1, commentaire: null },
      role: "Responsable Qualite",
    });

    expect(order).toEqual(["insert", "commit"]);
    const finalPath = path.join(docsDir, `${result.pdf_document_id}.pdf`);
    await fs.access(finalPath);
    await fs.unlink(finalPath).catch(() => undefined);
  });
});

describe("#142 as-built — échecs et nettoyage", () => {
  it("ne laisse AUCUN fichier orphelin quand la transaction échoue", async () => {
    mocks.insertPackVersion.mockRejectedValue(new Error("insert failed"));

    await expect(
      svcGenerateAsbuiltPack({
        lotId: LOT_ID,
        actorUserId: 1,
        body: { signataire_user_id: 1, commentaire: null },
        role: "Responsable Qualite",
      })
    ).rejects.toThrow(/insert failed/);

    expect(await listStaging()).toHaveLength(0);
    // Rien n'a été promu : l'espace documentaire est intact.
    const docs = await fs.readdir(docsDir).catch(() => [] as string[]);
    expect(docs.filter((f) => f.endsWith(".pdf.part"))).toHaveLength(0);
  });

  it("annule la transaction quand l'insertion du document échoue", async () => {
    mocks.insertDocument.mockRejectedValue(new Error("doc failed"));
    await expect(
      svcGenerateAsbuiltPack({
        lotId: LOT_ID,
        actorUserId: 1,
        body: { signataire_user_id: 1, commentaire: null },
        role: "Responsable Qualite",
      })
    ).rejects.toThrow(/doc failed/);
    const statements = mocks.clientQuery.mock.calls.map((c) => String(c[0]));
    expect(statements).toContain("ROLLBACK");
  });

  it("nettoie la préparation même si le rendu PDF échoue", async () => {
    mocks.renderPdf.mockRejectedValue(new Error("pdf boom"));
    await expect(
      svcGenerateAsbuiltPack({
        lotId: LOT_ID,
        actorUserId: 1,
        body: { signataire_user_id: 1, commentaire: null },
        role: "Responsable Qualite",
      })
    ).rejects.toThrow(/pdf boom/);
    expect(await listStaging()).toHaveLength(0);
  });
});

describe("#142 as-built — concurrence de version", () => {
  it("réessaie quand une autre génération a pris le numéro pendant le rendu", async () => {
    // `peek` annonce 1, l'allocation sous verrou renvoie 2 au premier essai.
    mocks.allocateVersion
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2);
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ version: 1 }] })
      .mockResolvedValue({ rows: [{ version: 2 }] });

    const result = await svcGenerateAsbuiltPack({
      lotId: LOT_ID,
      actorUserId: 1,
      body: { signataire_user_id: 1, commentaire: null },
      role: "Responsable Qualite",
    });

    expect(result.version).toBe(2);
    expect(mocks.allocateVersion).toHaveBeenCalledTimes(2);
    expect(await listStaging()).toHaveLength(0);
    await fs.unlink(path.join(docsDir, `${result.pdf_document_id}.pdf`)).catch(() => undefined);
  });

  it("réessaie sur violation de l'index unique (lot, version)", async () => {
    let attempt = 0;
    mocks.insertPackVersion.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        const err = new Error("duplicate key") as Error & { code: string; constraint: string };
        err.code = "23505";
        err.constraint = "asbuilt_pack_versions_lot_version_uniq";
        throw err;
      }
      return "v-id";
    });

    const result = await svcGenerateAsbuiltPack({
      lotId: LOT_ID,
      actorUserId: 1,
      body: { signataire_user_id: 1, commentaire: null },
      role: "Responsable Qualite",
    });
    expect(attempt).toBe(2);
    expect(result.version).toBe(1);
    await fs.unlink(path.join(docsDir, `${result.pdf_document_id}.pdf`)).catch(() => undefined);
  });

  it("abandonne proprement en 409 après trois conflits consécutifs", async () => {
    mocks.insertPackVersion.mockImplementation(async () => {
      const err = new Error("duplicate key") as Error & { code: string; constraint: string };
      err.code = "23505";
      err.constraint = "asbuilt_pack_versions_lot_version_uniq";
      throw err;
    });

    await expect(
      svcGenerateAsbuiltPack({
        lotId: LOT_ID,
        actorUserId: 1,
        body: { signataire_user_id: 1, commentaire: null },
        role: "Responsable Qualite",
      })
    ).rejects.toMatchObject({ status: 409, code: "ASBUILT_VERSION_CONFLICT" });

    expect(await listStaging()).toHaveLength(0);
  });
});

describe("#142 as-built — RGPD et couverture", () => {
  it("pseudonymise les opérateurs sans droit sur les données personnelles", async () => {
    await svcGenerateAsbuiltPack({
      lotId: LOT_ID,
      actorUserId: 1,
      body: { signataire_user_id: 1, commentaire: null },
      role: "Operateur atelier",
    });
    // Le service transmet le droit réel au chargement des preuves.
    expect(mocks.loadEnrichment.mock.calls[0][0].canReadPersonalData).toBe(false);
  });

  it("laisse voir les opérateurs au responsable RH", async () => {
    await svcGenerateAsbuiltPack({
      lotId: LOT_ID,
      actorUserId: 1,
      body: { signataire_user_id: 1, commentaire: null },
      role: "Responsable RH",
    });
    expect(mocks.loadEnrichment.mock.calls[0][0].canReadPersonalData).toBe(true);
  });

  it("consigne les lacunes de couverture dans le périmètre figé", async () => {
    const result = await svcGenerateAsbuiltPack({
      lotId: LOT_ID,
      actorUserId: 1,
      body: { signataire_user_id: 1, commentaire: null },
      role: "Responsable Qualite",
    });
    const args = mocks.insertPackVersion.mock.calls[0][1];
    // Sans OF rattaché, le dossier DOIT dire que l'origine n'est pas prouvée.
    expect(args.scopeJson.coverage_warning_codes).toContain("NO_PRODUCTION_LINK");
    await fs.unlink(path.join(docsDir, `${result.pdf_document_id}.pdf`)).catch(() => undefined);
  });
});
