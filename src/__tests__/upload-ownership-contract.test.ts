import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(__dirname, "..");

const helperOwnedRepositories = [
  "module/commande-client/repository/commande-client.repository.ts",
  "module/devis/repository/devis.repository.ts",
  "module/fournisseurs/repository/fournisseurs.repository.ts",
  "module/livraisons/repository/livraisons.repository.ts",
  "module/metrologie/repository/metrologie.repository.ts",
  "module/metrologie/repository/metrology-execution.repository.ts",
  "module/operation-dossiers/repository/operation-dossiers.repository.ts",
  "module/pieces-techniques/repository/pieces-techniques.repository.ts",
  "module/planning/repository/planning.repository.ts",
  "module/production/repository/machine-park.repository.ts",
  "module/qualite/repository/qualite.repository.ts",
  "module/receptions/repository/receptions.repository.ts",
  "module/stock/repository/stock.repository.ts",
] as const;

describe("durable upload ownership coverage", () => {
  for (const relativePath of helperOwnedRepositories) {
    it(`${relativePath} delegates every registered destination to the shared transaction owner`, () => {
      const contents = fs.readFileSync(path.join(sourceRoot, relativePath), "utf8");
      expect(contents).toContain("registerUploadDestination");
      expect(contents).toContain("withUploadTransaction");
      expect(contents).toContain("reconcile:");
    });
  }

  it("keeps GED on its audited fresh-read reconciliation adapter", () => {
    const service = fs.readFileSync(path.join(sourceRoot, "module/ged/services/ged.service.ts"), "utf8");
    expect(service).toContain("beforeCommit: () => markUploadCommitAttempted(files)");
    expect(service).toContain("afterCommit: () => markUploadsCommitted(files)");
    expect(service).toContain("repoIsVersionBlobCommitted(error.transactionResult.versionId, sha256)");
    expect(service).toContain('outcome === "committed"');
    expect(service).toContain('outcome === "not-committed"');
    expect(service).toContain("durableFilePresent");
    expect(service).toContain("cleanupUploadsAfterReconciledNoCommit(files)");
  });

  it("keeps Project Office evidence on exact fresh-read reconciliation", () => {
    const service = fs.readFileSync(
      path.join(sourceRoot, "module/project-office/services/project-office-registers.service.ts"),
      "utf8"
    );
    expect(service).toContain("err instanceof PoCommitUncertainError");
    expect(service).toContain("repoGetEvidenceFileById(result.file.id)");
    expect(service).toContain("persisted.sha256 === sha256 && persisted.storage_key === storageKey");
    expect(service).toContain("durableFilePresent");
    expect(service).toContain("written && !(err instanceof PoRollbackUncertainError)");
  });
});
