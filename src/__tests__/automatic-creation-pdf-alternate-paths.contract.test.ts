import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]) => fs.readFileSync(path.resolve(process.cwd(), ...parts), "utf8");
const body = (source: string, marker: string) => {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\nexport ", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
};
const beforeCommit = (source: string, queue: string) => {
  expect(source.indexOf(queue)).toBeGreaterThan(-1);
  expect(source.lastIndexOf("COMMIT")).toBeGreaterThan(source.indexOf(queue));
};

describe("automatic creation PDFs: alternate transaction paths", () => {
  const supplier = read("src/module/commande-fournisseur/repository/commande-fournisseur.repository.ts");
  const replenishment = read("src/module/commande-fournisseur/repository/replenishment-proposal.repository.ts");
  const stock = read("src/module/stock/repository/stock.repository.ts");
  const quotes = read("src/module/devis/repository/devis.repository.ts");

  it("queues the supplier PO snapshot after lines/totals/transition and before commit for normal, proposal-confirm and duplicate draft creates", () => {
    for (const marker of ["export async function repoCreateCommandeFournisseur", "export async function repoConfirmPropositions", "export async function repoDuplicateAsDraft"]) {
      const slice = body(supplier, marker);
      const queue = slice.indexOf("queueSupplierPurchaseOrderCreationPdfTx");
      expect(queue).toBeGreaterThan(slice.indexOf("recomputeTotauxTx"));
      expect(queue).toBeGreaterThan(slice.indexOf("insertTransitionRow"));
      expect(slice.lastIndexOf('client.query("COMMIT")')).toBeGreaterThan(queue);
    }
  });

  it("derives the supplier line net amount from deployed columns", () => {
    const snapshotStart = supplier.indexOf("async function buildSupplierPoCreationSnapshot");
    const snapshot = supplier.slice(snapshotStart, supplier.indexOf("const issuer = await readIssuerParty", snapshotStart));
    expect(snapshot).toContain("round(round(quantite * prix_unitaire_ht, 2) - round(quantite * prix_unitaire_ht * remise_pct / 100, 2) + frais_ht, 2)::text AS net_ht");
    expect(snapshot).not.toContain("net_ht::text,");
  });

  it("queues the replenishment conversion snapshot after its transition and before commit", () => {
    const slice = body(replenishment, "export async function repoValidateReplenishmentProposal");
    const queue = slice.indexOf("queueSupplierPurchaseOrderCreationPdfTx");
    expect(queue).toBeGreaterThan(slice.indexOf("commande_fournisseur_transition"));
    expect(slice.lastIndexOf('client.query("COMMIT")')).toBeGreaterThan(queue);
  });

  it("keeps stock creation snapshots on explicit article creation only, excluding OLD historical import", () => {
    const createStart = stock.indexOf("export async function repoCreateArticle");
    const create = stock.slice(createStart, stock.indexOf("export async function repoCreateHistoricalImport", createStart));
    beforeCommit(create, "queueStockArticleCreationSnapshotTx");
    const historical = body(stock, "export async function repoCreateHistoricalImport");
    expect(historical).not.toContain("queueStockArticleCreationSnapshotTx");
    const finish = read("src/module/surface-finish/repository/surface-finish-resolution.repository.ts");
    for (const marker of ["export async function repoConfirmStockFinishArticle", "export async function repoConfirmOperationFinish"]) {
      beforeCommit(body(finish, marker), "queueStockArticleCreationSnapshotTx");
    }
  });

  it("uses the quote creation helper for normal creates and queues revisions after materialized lines/documents/audit/idempotency", () => {
    const normal = body(quotes, "export async function repoCreateDevis");
    expect(normal).toContain("queueDevisCreationPdfTx");
    const revision = body(quotes, "export async function repoReviseDevis");
    const queue = revision.indexOf("queueDevisCreationPdfTx");
    expect(queue).toBeGreaterThan(revision.indexOf("insertDevisDocuments"));
    expect(queue).toBeGreaterThan(revision.indexOf("insertDevisAuditLog"));
    expect(queue).toBeGreaterThan(revision.indexOf("recordDevisIdempotence"));
    expect(queue).toBeLessThan(revision.indexOf("return { ...resultat"));
  });
});
