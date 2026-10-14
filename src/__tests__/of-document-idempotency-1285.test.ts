import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), stored: vi.fn() }));
vi.mock("../module/production/repository/of-versioning.repository", () => ({
  withOfDocumentReadTransaction: async (read: (tx: unknown) => unknown) => read({}), findDocumentByIdempotencyKey: mocks.find,
}));
vi.mock("../module/production/services/of-document-stored-pdf", () => ({ readOfDocumentStoredPdf: mocks.stored }));
import { emitDocument } from "../module/production/services/of-versioning.service";
const document = { of_id: 95, revision_id: "revision-95", payload: { documentStatut:"OFFICIEL",snapshotSha256: "hash-95", sourceFingerprint: "facts-95" } };
const actor = { userId: 1, username: "Recette" } as Parameters<typeof emitDocument>[2];
const audit = {} as Parameters<typeof emitDocument>[3];
beforeEach(() => { vi.resetAllMocks(); mocks.find.mockResolvedValue(document); mocks.stored.mockResolvedValue({ pdf: Buffer.from("saved") }); });
it("a retry returns the previously saved PDF even when later edition facts have changed", async () => {
  const result = await emitDocument(95, { revisionId: "revision-95", expectedSnapshotSha256: "hash-95", expectedSourceFingerprint: "facts-95" }, actor, audit, "retry", "2030-01-01");
  expect(result.replayed).toBe(true);
  expect(result.pdf.toString()).toBe("saved");
  expect(mocks.stored).toHaveBeenCalledWith(document);
});
it.each([
  [101, "revision-95", "hash-95", "facts-95"], [95, "revision-101", "hash-95", "facts-95"],
  [95, "revision-95", "different-hash", "facts-95"], [95, "revision-95", "hash-95", "different-facts"],
])("a reused key cannot reveal or replay an unrelated edition", async (ofId, revisionId, snapshot, facts) => {
  await expect(emitDocument(ofId, { revisionId, expectedSnapshotSha256: snapshot, expectedSourceFingerprint: facts }, actor, audit, "retry", "2030-01-01"))
    .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  expect(mocks.stored).not.toHaveBeenCalled();
});
