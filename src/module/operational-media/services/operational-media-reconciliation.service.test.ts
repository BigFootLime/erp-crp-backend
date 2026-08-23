import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), scan: vi.fn(), verify: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: { query: mocks.query } }));
vi.mock("../../../utils/imageStorage", () => ({ getImagesRootPath: () => "/safe/images" }));
vi.mock("../../../utils/logger", () => ({ default: { info: mocks.info, warn: mocks.warn } }));
vi.mock("../../../shared/uploads/upload-scanner", () => ({ scanUpload: mocks.scan }));
vi.mock("./operational-media-promotion.service", () => ({ verifyOperationalRaster: mocks.verify }));

import { reconcileLegacyOperationalMedia } from "./operational-media-reconciliation.service";

const asset = { id: "4a99e772-4496-4c0d-a5a2-2b82c1f8c5c1", storage_key: "machines/a.png", has_raster_only_binding: false };

afterEach(() => vi.resetAllMocks());

describe("legacy operational-media reconciliation", () => {
  it("activates only a clean scanner verdict after durable byte verification", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [asset] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const bytes = Buffer.from("verified-image");
    mocks.verify.mockResolvedValue({ mimeType: "image/png", size: 12, sha256: "a".repeat(64), filePath: "/safe/images/machines/a.png", bytes });
    mocks.scan.mockResolvedValue({ status: "clean", provider: "clamdscan" });

    await expect(reconcileLegacyOperationalMedia()).resolves.toEqual({ examined: 1, activated: 1, quarantined_invalid: 0, quarantined_infected: 0, scanner_unavailable: 0 });
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ includeBytes: true }));
    expect(mocks.scan).toHaveBeenCalledWith({ buffer: bytes });
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain("status = 'ACTIVE'");
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([asset.id, "image/png", 12, "a".repeat(64)]);
  });

  it("quarantines missing/invalid rasters and infected verdicts without leaking paths", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [asset] }).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [] });
    mocks.verify.mockResolvedValue(null);
    await expect(reconcileLegacyOperationalMedia()).resolves.toMatchObject({ quarantined_invalid: 1 });
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain("'QUARANTINED'");
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(asset.storage_key);

    vi.resetAllMocks();
    mocks.query.mockResolvedValueOnce({ rows: [asset] }).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [] });
    mocks.verify.mockResolvedValue({ mimeType: "image/png", size: 12, sha256: "a".repeat(64), filePath: "/safe/images/machines/a.png", bytes: Buffer.from("infected") });
    mocks.scan.mockResolvedValue({ status: "infected", provider: "clamdscan" });
    await expect(reconcileLegacyOperationalMedia()).resolves.toMatchObject({ quarantined_infected: 1, activated: 0 });
  });

  it("does not update or retry-spin when the scanner is unavailable", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [asset] });
    mocks.verify.mockResolvedValue({ mimeType: "image/png", size: 12, sha256: "a".repeat(64), filePath: "/safe/images/machines/a.png", bytes: Buffer.from("unavailable") });
    mocks.scan.mockResolvedValue({ status: "unavailable", provider: "none" });

    await expect(reconcileLegacyOperationalMedia()).resolves.toEqual({ examined: 1, activated: 0, quarantined_invalid: 0, quarantined_infected: 0, scanner_unavailable: 1 });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("quarantines a legacy PDF bound to any raster-only surface before it can be exposed", async () => {
    const primaryImagePdf = { ...asset, storage_key: "outillage/outils/legacy.pdf", has_raster_only_binding: true };
    mocks.query.mockResolvedValueOnce({ rows: [primaryImagePdf] }).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [] });
    mocks.verify.mockResolvedValue({ mimeType: "application/pdf", size: 12, sha256: "a".repeat(64), filePath: "/safe/images/outillage/outils/legacy.pdf", bytes: Buffer.from("%PDF-1.7") });

    await expect(reconcileLegacyOperationalMedia()).resolves.toMatchObject({ quarantined_invalid: 1, activated: 0 });
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(String(mocks.query.mock.calls[1]?.[0])).toContain("'QUARANTINED'");
  });

  it("allows a verified PDF that is bound only to a tool plan or sketch", async () => {
    const planPdf = { ...asset, storage_key: "outillage/outils/plan.pdf", has_raster_only_binding: false };
    mocks.query
      .mockResolvedValueOnce({ rows: [planPdf] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const bytes = Buffer.from("%PDF-1.7");
    mocks.verify.mockResolvedValue({ mimeType: "application/pdf", size: bytes.length, sha256: "b".repeat(64), filePath: "/safe/images/outillage/outils/plan.pdf", bytes });
    mocks.scan.mockResolvedValue({ status: "clean", provider: "clamdscan" });

    await expect(reconcileLegacyOperationalMedia()).resolves.toMatchObject({ activated: 1, quarantined_invalid: 0 });
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([planPdf.id, "application/pdf", bytes.length, "b".repeat(64)]);
  });
});
