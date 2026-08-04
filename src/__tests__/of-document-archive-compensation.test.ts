import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  coordinate: vi.fn(),
  referenceState: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock("../module/ged/repository/ged.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/ged/repository/ged.repository")>();
  return {
    ...actual,
    withGedBlobSha256Coordination: mocks.coordinate,
    repoGetGedBlobReferenceState: mocks.referenceState,
  };
});

vi.mock("../module/ged/services/ged-vault.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/ged/services/ged-vault.service")>();
  return { ...actual, cleanupOwnedVaultBlob: mocks.cleanup };
});

import { GedBlobCleanupUncertainError } from "../module/ged/repository/ged.repository";
import { compensateOfDocumentArchive } from "../module/production/services/of-document-archive";

const created = {
  archived: true,
  gedDocumentId: "ged-document",
  gedVersionId: "ged-version",
  skippedReason: null,
  blobOwnership: {
    kind: "created" as const,
    destination: "C:\\private\\vault\\blob",
    dev: "1",
    ino: "2",
  },
  blobSha256: "a".repeat(64),
  blobStorageKey: `vault/sha256/aa/aa/${"a".repeat(64)}`,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.coordinate.mockImplementation(async (_sha, work) => work({ query: vi.fn() }));
  mocks.referenceState.mockResolvedValue({ blob_present: false, reference_count: 0 });
  mocks.cleanup.mockResolvedValue(undefined);
});

describe("OF GED blob compensation", () => {
  it("supprime l'inode créé sous le même verrou SHA après relecture fraîche sans référence", async () => {
    await compensateOfDocumentArchive(created);

    expect(mocks.coordinate).toHaveBeenCalledWith(created.blobSha256, expect.any(Function));
    expect(mocks.referenceState).toHaveBeenCalledWith(expect.anything(), created.blobSha256);
    expect(mocks.cleanup).toHaveBeenCalledWith(created.blobOwnership);
  });

  it.each([
    { blob_present: true, reference_count: 0 },
    { blob_present: false, reference_count: 1 },
  ])("préserve si une référence fraîche existe: %o", async (state) => {
    mocks.referenceState.mockResolvedValue(state);

    await compensateOfDocumentArchive(created);

    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it("ne tente jamais de supprimer un blob dédupliqué préexistant", async () => {
    await compensateOfDocumentArchive({
      ...created,
      blobOwnership: { kind: "deduplicated" },
    });

    expect(mocks.coordinate).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it("rend toute panne de rapprochement explicitement incertaine", async () => {
    mocks.referenceState.mockRejectedValue(new Error("database unavailable"));

    await expect(compensateOfDocumentArchive(created))
      .rejects.toBeInstanceOf(GedBlobCleanupUncertainError);
  });
});
