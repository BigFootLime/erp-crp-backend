import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lstat: vi.fn(), realpath: vi.fn(), open: vi.fn() }));
vi.mock("node:fs/promises", () => ({ default: { lstat: mocks.lstat, realpath: mocks.realpath, open: mocks.open } }));
vi.mock("../../../utils/imageStorage", () => ({
  getImagesRootPath: () => root,
  normalizeStoredImagePath: (value: string) => value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
}));

import { promoteOperationalImage } from "./operational-media-promotion.service";

const root = "C:\\generated\\images";
const assetId = "4a99e772-4496-4c0d-a5a2-2b82c1f8c5c1";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const gif = Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0080\u0000\u0000\u0000\u0000\u0000\u00ff\u00ff\u00ff!\u00f9\u0004\u0001\u0000\u0000\u0000\u0000,");
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function file(data: Buffer, scanStatus: "clean" | "unavailable" | "pending" | "infected" = "clean", sha256 = hash(data)) {
  return { size: data.length, uploadSecurity: { scanStatus, sha256 } } as unknown as Express.Multer.File;
}
function stat(data: Buffer, ino = 5) { return { dev: 1n, ino: BigInt(ino), size: BigInt(data.length), isFile: () => true, isSymbolicLink: () => false }; }
function arrange(data: Buffer, suffix = "a.png") {
  const candidate = `${root}\\outillage\\${suffix}`;
  const handle = {
    stat: vi.fn().mockResolvedValue(stat(data)),
    read: vi.fn(async (buffer: Buffer, _offset: number, length: number, position: number) => {
      data.copy(buffer, 0, position, position + length);
      return { bytesRead: Math.max(0, Math.min(length, data.length - position)) };
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  mocks.realpath.mockImplementation(async (value: string) => value === root ? root : candidate);
  mocks.lstat.mockResolvedValue(stat(data));
  mocks.open.mockResolvedValue(handle);
  return handle;
}

beforeEach(() => vi.clearAllMocks());

describe("operational image promotion", () => {
  it.each([["a.png", png, "image/png"], ["a.jpg", jpeg, "image/jpeg"], ["a.webp", webp, "image/webp"], ["a.gif", gif, "image/gif"], ["plan.pdf", pdf, "application/pdf"]])("activates clean %s by bytes, not extension lookup", async (name, data, mimeType) => {
    arrange(data as Buffer, name as string);
    const tx = { query: vi.fn().mockResolvedValue({ rows: [{ id: assetId }] }) };
    await expect(promoteOperationalImage({ tx, storedPath: `outillage/${name}`, file: file(data as Buffer) })).resolves.toEqual({ activated: true, asset_id: assetId, mime_type: mimeType });
    expect(tx.query.mock.calls[0]?.[1]).toEqual([`outillage/${name}`, mimeType, (data as Buffer).length, hash(data as Buffer)]);
  });

  it("rejects signature/extension, hash and Multer-size mismatches with no DB write", async () => {
    arrange(jpeg);
    const tx = { query: vi.fn() };
    await expect(promoteOperationalImage({ tx, storedPath: "outillage/a.png", file: file(jpeg) })).resolves.toMatchObject({ activated: false });
    vi.clearAllMocks(); arrange(png);
    await expect(promoteOperationalImage({ tx, storedPath: "outillage/a.png", file: file(png, "clean", "b".repeat(64)) })).resolves.toMatchObject({ activated: false });
    vi.clearAllMocks(); arrange(png);
    await expect(promoteOperationalImage({ tx, storedPath: "outillage/a.png", file: { ...file(png), size: png.length + 1 } as Express.Multer.File })).resolves.toMatchObject({ activated: false });
    expect(tx.query).not.toHaveBeenCalled();
  });

  it("does zero filesystem/database work for unavailable, pending and infected scans", async () => {
    const tx = { query: vi.fn() };
    for (const status of ["unavailable", "pending", "infected"] as const) await promoteOperationalImage({ tx, storedPath: "outillage/a.png", file: file(png, status) });
    expect(mocks.lstat).not.toHaveBeenCalled(); expect(mocks.realpath).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled(); expect(tx.query).not.toHaveBeenCalled();
  });

  it("rejects symlink, path escape and identity swap without activation", async () => {
    const tx = { query: vi.fn() };
    mocks.realpath.mockResolvedValue(root);
    mocks.lstat.mockResolvedValue({ ...stat(png), isSymbolicLink: () => true });
    await expect(promoteOperationalImage({ tx, storedPath: "outillage/a.png", file: file(png) })).resolves.toMatchObject({ activated: false });
    await expect(promoteOperationalImage({ tx, storedPath: "../escape.png", file: file(png) })).rejects.toMatchObject({ code: "MEDIA_INVALID_STORAGE_KEY" });
    vi.clearAllMocks(); const handle = arrange(png);
    handle.stat.mockResolvedValueOnce(stat(png, 5)).mockResolvedValueOnce(stat(png, 6));
    await expect(promoteOperationalImage({ tx, storedPath: "outillage/a.png", file: file(png) })).resolves.toMatchObject({ activated: false });
    expect(tx.query).not.toHaveBeenCalled();
  });

  it("updates only legacy-unverified rows, never quarantine/revocation", async () => {
    arrange(png);
    const tx = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await expect(promoteOperationalImage({ tx, storedPath: "outillage/a.png", file: file(png) })).resolves.toMatchObject({ activated: false });
    expect(String(tx.query.mock.calls[0]?.[0])).toContain("status = 'LEGACY_UNVERIFIED'");
    expect(String(tx.query.mock.calls[0]?.[0])).not.toContain("QUARANTINED");
  });
});
