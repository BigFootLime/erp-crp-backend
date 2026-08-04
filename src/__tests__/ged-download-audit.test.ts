import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  downloadVersion: vi.fn(),
  recordVersionDownload: vi.fn(),
  sendSecureStoredFile: vi.fn(),
}));

vi.mock("../module/ged/services/ged.service", () => ({
  downloadVersion: mocks.downloadVersion,
  recordVersionDownload: mocks.recordVersionDownload,
}));

vi.mock("../shared/uploads/secure-download", () => ({
  sendSecureStoredFile: mocks.sendSecureStoredFile,
}));

import { downloadVersion } from "../module/ged/controllers/ged.controller";

const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const SHA256 = "a".repeat(64);
const download = {
  file_path: "/private/vault/blob",
  allowed_root: "/private/vault",
  size_bytes: 123,
  original_name: "plan.pdf",
  mime_type: "application/pdf",
  sha256: SHA256,
  document_id: "11111111-1111-4111-8111-111111111111",
  version_id: VERSION_ID,
};

describe("GED download audit completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.downloadVersion.mockResolvedValue(download);
    mocks.recordVersionDownload.mockResolvedValue(undefined);
  });

  it("ne journalise pas DOWNLOAD quand le transport HTTP est abandonné", async () => {
    mocks.sendSecureStoredFile.mockResolvedValue("aborted");
    const next = vi.fn();
    const response = { setHeader: vi.fn() };

    await downloadVersion(
      {
        params: { versionId: VERSION_ID },
        user: { id: 7, role: "administrateur" },
      } as never,
      response as never,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(mocks.recordVersionDownload).not.toHaveBeenCalled();
  });

  it("journalise DOWNLOAD seulement après un transport terminé", async () => {
    mocks.sendSecureStoredFile.mockResolvedValue("completed");
    const next = vi.fn();
    const response = { setHeader: vi.fn() };

    await downloadVersion(
      {
        params: { versionId: VERSION_ID },
        user: { id: 7, role: "administrateur" },
      } as never,
      response as never,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(mocks.recordVersionDownload).toHaveBeenCalledTimes(1);
    expect(mocks.recordVersionDownload).toHaveBeenCalledWith(
      { id: 7, role: "administrateur" },
      download,
      "DOWNLOAD"
    );
  });
});
