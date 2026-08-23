import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildTechnicalPieceCreationSnapshotInput } from "../shared/authoritative-documents/technical-piece-creation-snapshot";
import { buildStockArticleCreationSnapshotInput } from "../shared/authoritative-documents/stock-article-creation-snapshot";

const piecesSource = fs.readFileSync(path.join(__dirname, "../module/pieces-techniques/repository/pieces-techniques.repository.ts"), "utf8");
const commandesSource = fs.readFileSync(path.join(__dirname, "../module/commande-client/repository/commande-client.repository.ts"), "utf8");
const stockSource = fs.readFileSync(path.join(__dirname, "../module/stock/repository/stock.repository.ts"), "utf8");

describe("technical root creation PDF contracts", () => {
  it("uses stable, safe, server-only creation inputs", () => {
    const technical = buildTechnicalPieceCreationSnapshotInput({
      id: "11111111-1111-1111-1111-111111111111", code: "PT/ 01", designation: "Piece", clientId: "client-1", clientName: null,
      status: "DRAFT", sourceRevision: "2026-08-23T12:00:00.000Z", actorUserId: 7, articleId: null, familyId: null,
    });
    const article = buildStockArticleCreationSnapshotInput({
      id: "22222222-2222-2222-2222-222222222222", code: "ART/ 01", designation: "Article", articleType: "PURCHASED",
      articleCategory: "achat", familyCode: "ACH", unit: "u", status: "VALIDE", stockManaged: true, lotTracking: false,
      isActive: true, sourceRevision: "2026-08-23T12:00:00.000Z", actorUserId: 7,
    });
    expect(technical).toMatchObject({ entityType: "piece-technique", documentKind: "TECHNICAL_PIECE_CREATION_SNAPSHOT", idempotencyKey: "piece-technique:11111111-1111-1111-1111-111111111111:creation:v1" });
    expect(article).toMatchObject({ entityType: "stock-article", documentKind: "STOCK_ARTICLE_CREATION_SNAPSHOT", idempotencyKey: "stock-article:22222222-2222-2222-2222-222222222222:creation:v1" });
    expect(technical.originalName).toBe("piece-technique-PT-01-creation.pdf");
    expect(article.originalName).toBe("article-ART-01-creation.pdf");
    expect(JSON.stringify(technical.sourceSnapshot)).not.toMatch(/upload|path|file/i);
  });

  it("queues a duplicated technical root only after its copied aggregate and before commit", () => {
    const duplicate = piecesSource.slice(piecesSource.indexOf("export async function repoDuplicatePieceTechnique"));
    const history = duplicate.indexOf("INSERT INTO pieces_techniques_historique");
    const queue = duplicate.indexOf("await queueCreationPdfArchive(client, buildTechnicalPieceCreationSnapshotInput");
    const commit = duplicate.indexOf('await client.query("COMMIT")');
    expect(history).toBeGreaterThan(0);
    expect(queue).toBeGreaterThan(history);
    expect(queue).toBeLessThan(commit);
    expect(duplicate).toContain("copiedFromCode: o.code_piece");
  });

  it("queues preparatory promotions only for fresh root rows and excludes OLD recovery imports", () => {
    const technical = commandesSource.slice(commandesSource.indexOf("async function ensureOfficialPieceFromPreparatory"), commandesSource.indexOf("async function ensureOfficialArticleFromPreparatory"));
    const article = commandesSource.slice(commandesSource.indexOf("async function ensureOfficialArticleFromPreparatory"), commandesSource.indexOf("let commandeToAffaireHasRoleColumnCache"));
    expect(technical).toContain("RETURNING id::text AS id, updated_at::text AS updated_at");
    expect(technical).toContain("buildTechnicalPieceCreationSnapshotInput");
    expect(technical).toContain("preparatory-piece-promotion");
    expect(article).toContain("buildStockArticleCreationSnapshotInput");
    expect(article).toContain("preparatory-article-promotion");
    expect(article).toContain("if (createdArticle)");
    expect(stockSource).toContain("OLD recovery/import scaffolding is intentionally excluded from creation-PDF");
  });
});
