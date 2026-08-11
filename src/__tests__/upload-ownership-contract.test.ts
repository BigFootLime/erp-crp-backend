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
    it(`${relativePath} delegates every durable transfer to the shared transaction owner`, () => {
      const contents = fs.readFileSync(path.join(sourceRoot, relativePath), "utf8");
      expect(contents).toContain("transferSecureUploadToDestination");
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

  it("locks the same SHA before every GED promotion and coordinated cleanup", () => {
    const service = fs.readFileSync(path.join(sourceRoot, "module/ged/services/ged.service.ts"), "utf8");
    const ofArchive = fs.readFileSync(
      path.join(sourceRoot, "module/production/services/of-document-archive.ts"),
      "utf8"
    );
    const uploadDocument = service.slice(
      service.indexOf("export async function uploadDocument"),
      service.indexOf("export async function uploadNewVersion")
    );
    const uploadNewVersion = service.slice(
      service.indexOf("export async function uploadNewVersion"),
      service.indexOf("async function transitionVersion")
    );

    for (const writer of [uploadDocument, uploadNewVersion]) {
      expect(writer.indexOf("repoLockGedBlobSha256(tx, expectedSha256)")).toBeGreaterThanOrEqual(0);
      expect(writer.indexOf("writeBlobFromPath(publicationFile, expectedSha256)"))
        .toBeGreaterThan(writer.indexOf("repoLockGedBlobSha256(tx, expectedSha256)"));
    }
    expect(ofArchive.indexOf("repoLockGedBlobSha256(tx, pdfSha256)"))
      .toBeLessThan(ofArchive.indexOf("writeBlob(pdf)"));
    expect(service).toContain("withGedBlobSha256Coordination(sha256");
    expect(service).toContain("repoGetGedBlobReferenceState(tx, sha256)");
  });

  it("keeps Project Office evidence on exact fresh-read reconciliation", () => {
    const service = fs.readFileSync(
      path.join(sourceRoot, "module/project-office/services/project-office-registers.service.ts"),
      "utf8"
    );
    expect(service).toContain("err instanceof PoCommitUncertainError");
    expect(service).toContain("repoGetEvidenceFileById(result.file.id)");
    expect(service).toContain("persisted.evidence_id === result.evidence.id");
    expect(service).toContain("persisted.project_id === projectId");
    expect(service).toContain("persisted.storage_key === storageKey");
    expect(service).toContain("persisted.sha256 === sha256");
    expect(service).toContain("persisted.size_bytes === file.buffer.byteLength");
    expect(service).toContain("writeSecureBufferToDestination(file.buffer, destination)");
    expect(service).toContain("verifySecureBufferDestination(ownership, sha256, file.buffer.byteLength)");
    expect(service).toContain("cleanupSecureBufferDestination(ownership)");
    expect(service).toContain("ownership && !(err instanceof PoRollbackUncertainError)");
  });

  it("routes every audited inbound rejection through observable identity cleanup", () => {
    const inboundCleanupFiles = [
      "module/production/controllers/machine-park.controller.ts",
      "module/production/repository/machine-park.repository.ts",
      "module/operation-dossiers/controllers/operation-dossiers.controller.ts",
      "module/livraisons/services/livraisons-document-validation.ts",
      "module/stock/services/article-document-validation.ts",
    ];
    for (const relativePath of inboundCleanupFiles) {
      const contents = fs.readFileSync(path.join(sourceRoot, relativePath), "utf8");
      expect(contents).toContain("cleanupIncomingUploadStaging");
      expect(contents).not.toMatch(/unlink\([^\n]*(?:req\.file|file\.path|f\.path)/);
      expect(contents).not.toMatch(/unlink\([^\n]*catch\(\(\) => undefined\)/);
    }
  });
});
