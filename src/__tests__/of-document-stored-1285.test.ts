import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { OfDocumentRow } from "../module/production/repository/of-versioning.repository";
const mocks = vi.hoisted(() => ({ archive: vi.fn(), render: vi.fn() }));
vi.mock("../module/production/services/of-document-archive", () => ({ readArchivedOfDocument: mocks.archive }));
vi.mock("../module/production/services/of-document-render", () => ({ renderOfDocument: mocks.render }));
import { readOfDocumentStoredPdf } from "../module/production/services/of-document-stored-pdf";
const bytes = Buffer.from("saved old edition"), hash = createHash("sha256").update(bytes).digest("hex");
const saved = { payload: { templateVersion: "of-ordre-fabrication/1.2", ofNumero: "OLD-OF" },
  pdf_sha256: hash, pdf_byte_size: bytes.length } as unknown as OfDocumentRow;
beforeEach(() => { vi.resetAllMocks(); });
it("replays the saved archived bytes without regenerating a newer edition", async () => {
  mocks.archive.mockResolvedValue(bytes);
  expect(await readOfDocumentStoredPdf(saved)).toEqual({ pdf: bytes, source: "GED" });
  expect(mocks.render).not.toHaveBeenCalled();
});
it("recovers a missing archive only by rendering its saved payload", async () => {
  mocks.archive.mockResolvedValue(null); mocks.render.mockResolvedValue({ buffer: bytes });
  expect((await readOfDocumentStoredPdf(saved)).source).toBe("PAYLOAD");
  expect(mocks.render).toHaveBeenCalledWith(saved.payload);
});
it("rejects a corrupted archive and does not expose its digest to the operator", async () => {
  mocks.archive.mockResolvedValue(Buffer.from("corrupted"));
  const error = await readOfDocumentStoredPdf(saved).catch(error => error);
  expect(error.code).toBe("OF_DOCUMENT_REPRINT_MISMATCH");
  expect(error.message).not.toContain(hash);
});
it("rejects a saved edition with a mismatched size or missing PDF digest", async () => {
  mocks.archive.mockResolvedValue(bytes);
  await expect(readOfDocumentStoredPdf({ ...saved, pdf_byte_size: 1 })).rejects.toMatchObject({ code: "OF_DOCUMENT_REPRINT_MISMATCH" });
  await expect(readOfDocumentStoredPdf({ ...saved, pdf_sha256: null })).rejects.toMatchObject({ code: "OF_DOCUMENT_NO_PDF" });
});
