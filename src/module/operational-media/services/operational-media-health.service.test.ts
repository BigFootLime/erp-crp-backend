import { constants } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  access: vi.fn(),
  open: vi.fn(),
  unlink: vi.fn(),
  startup: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { stat: mocks.stat, access: mocks.access, open: mocks.open, unlink: mocks.unlink },
}));
vi.mock("../../../utils/imageStorage", () => ({
  getImagesRootPath: () => "/private/generated/images",
}));
vi.mock("../../../shared/uploads/upload-scanner", () => ({
  getUploadScannerStartupConfiguration: mocks.startup,
  probeUploadScannerHealth: mocks.probe,
}));

import {
  checkOperationalMediaStorage,
  collectOperationalMediaCapabilities,
} from "./operational-media-health.service";

const scannerReady = {
  mode: "enforce" as const,
  provider: "clamdscan" as const,
  command: "clamdscan",
  timeoutMs: 1_000,
  ready: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stat.mockResolvedValue({ isDirectory: () => true });
  mocks.access.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue({ writeFile: vi.fn().mockResolvedValue(undefined), sync: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) });
  mocks.unlink.mockResolvedValue(undefined);
  mocks.startup.mockReturnValue(scannerReady);
  mocks.probe.mockResolvedValue(scannerReady);
});

describe("operational media capability probes", () => {
  it("enables previews and upload promotion only when storage and scanner are measured ready", async () => {
    await expect(collectOperationalMediaCapabilities()).resolves.toMatchObject({
      status: "available",
      preview_supported: true,
      download_supported: true,
      upload_promotion_supported: true,
      storage: { ready: true, readable: true, writable: true, reason_code: null },
      antivirus: { ready: true, reason_code: null },
    });
    expect(mocks.access).toHaveBeenCalledWith("/private/generated/images", constants.R_OK);
    expect(mocks.open).toHaveBeenCalledWith(
      expect.stringContaining(".cerp-operational-media-probe-"),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringContaining(".cerp-operational-media-probe-"));
  });

  it("keeps historical preview available but disables writes for a read-only mount", async () => {
    mocks.open.mockRejectedValue(Object.assign(new Error("private path"), { code: "ENOSPC" }));

    const capabilities = await collectOperationalMediaCapabilities();

    expect(capabilities).toMatchObject({
      status: "degraded",
      preview_supported: true,
      download_supported: true,
      upload_promotion_supported: false,
      storage: { ready: false, readable: true, writable: false, reason_code: "not_writable" },
    });
    expect(JSON.stringify(capabilities)).not.toContain("private path");
  });

  it("fails closed without leaking filesystem errors when the image root is absent", async () => {
    mocks.stat.mockRejectedValue(Object.assign(new Error("C:\\customer\\secret"), { code: "ENOENT" }));

    await expect(checkOperationalMediaStorage()).resolves.toEqual({
      ready: false,
      readable: false,
      writable: false,
      reason: "unavailable",
    });
    const capabilities = await collectOperationalMediaCapabilities();
    expect(capabilities.preview_supported).toBe(false);
    expect(capabilities.upload_promotion_supported).toBe(false);
    expect(JSON.stringify(capabilities)).not.toContain("customer");
  });

  it("disables promotion when antivirus readiness is degraded", async () => {
    mocks.probe.mockResolvedValue({ ...scannerReady, ready: false, reason: "daemon_unavailable" });

    await expect(collectOperationalMediaCapabilities()).resolves.toMatchObject({
      status: "degraded",
      preview_supported: true,
      upload_promotion_supported: false,
      antivirus: { ready: false, reason_code: "daemon_unavailable" },
    });
  });
});
