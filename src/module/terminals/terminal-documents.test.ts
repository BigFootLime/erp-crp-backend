import { beforeEach, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({ ref: vi.fn(), blob: vi.fn(), grant: vi.fn() }));
vi.mock("../ged/repository/ged.repository", () => ({
  repoInternalGetVersionContentRef: m.ref,
}));
vi.mock("../ged/services/ged-vault.service", () => ({
  resolveBlobForDownload: m.blob,
}));
vi.mock("./services/terminal-auth.service", () => ({ requireModule: m.grant }));
import { downloadOfGedVersion } from "./services/terminal-document.service";
import type { OperationContext } from "./repository/terminal-dossier.repository";
const context = {
  technical_snapshot: {
    preparation_evidence: {
      documents: [{ version_id: "old", sha256: "frozen" }],
    },
  },
} as unknown as OperationContext;
beforeEach(() => {
  vi.clearAllMocks();
  m.grant.mockResolvedValue(undefined);
  m.ref.mockResolvedValue({
    version_id: "old",
    status: "APPLICABLE",
    sha256: "frozen",
    scan_status: "clean",
    quarantine_status: "released",
    storage_key: "key",
  });
  m.blob.mockResolvedValue({
    file_path: "private-file",
    allowed_root: "private-root",
  });
});
it("serves the released version to an authorized production operator", async () => {
  await expect(
    downloadOfGedVersion({ id: 7, role: "Opérateur" }, context, "old"),
  ).resolves.toMatchObject({ version_id: "old" });
  expect(m.grant).toHaveBeenCalledWith(7, "production");
});
it("never substitutes the latest plan for the released version", async () => {
  await expect(
    downloadOfGedVersion({ id: 7, role: "Opérateur" }, context, "new"),
  ).rejects.toMatchObject({ code: "TERMINAL_DOCUMENT_OUTSIDE_SCOPE" });
  expect(m.ref).not.toHaveBeenCalled();
});
it("keeps the frozen plan available after a new version supersedes it", async () => {
  m.ref.mockResolvedValue({
    version_id: "old",
    status: "OBSOLETE",
    sha256: "frozen",
    scan_status: "clean",
  });
  await expect(
    downloadOfGedVersion({ id: 7, role: "Opérateur" }, context, "old"),
  ).resolves.toMatchObject({ version_id: "old" });
});
it.each([
  { status: "BROUILLON", sha256: "frozen", scan_status: "clean" },
  { status: "APPLICABLE", sha256: "changed", scan_status: "clean" },
  { status: "APPLICABLE", sha256: "frozen", scan_status: "infected" },
  {
    status: "APPLICABLE",
    sha256: "frozen",
    scan_status: "clean",
    quarantine_status: "quarantined",
  },
])(
  "blocks an unsafe or changed document before resolving storage",
  async (ref) => {
    m.ref.mockResolvedValue(ref);
    await expect(
      downloadOfGedVersion({ id: 7, role: "Opérateur" }, context, "old"),
    ).rejects.toBeDefined();
    expect(m.blob).not.toHaveBeenCalled();
  },
);
