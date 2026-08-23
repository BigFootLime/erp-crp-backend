import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  claim: vi.fn(),
  runClaimed: vi.fn(),
}));

vi.mock("../config/database", () => ({ default: { connect: mocks.connect } }));
vi.mock("../shared/authoritative-documents/authoritative-document.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/authoritative-documents/authoritative-document.repository")>()),
  repoClaimAuthoritativePdfWork: mocks.claim,
}));
vi.mock("../shared/authoritative-documents/authoritative-document.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/authoritative-documents/authoritative-document.service")>()),
  runClaimedAuthoritativePdfArchive: mocks.runClaimed,
}));

import { AuthoritativePdfProducerRegistry } from "../shared/authoritative-documents/authoritative-document.service";
import { runAuthoritativePdfArchiveWorkerOnce } from "../shared/authoritative-documents/authoritative-document.worker";

afterEach(() => vi.restoreAllMocks());

describe("authoritative PDF archive worker", () => {
  it("continues to the next claimed job when one producer/archive job fails", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    const first = { outboxId: "11111111-1111-4111-8111-111111111111", archive: { id: "a" } };
    const second = { outboxId: "22222222-2222-4222-8222-222222222222", archive: { id: "b" } };
    mocks.connect.mockResolvedValue(client);
    mocks.claim.mockResolvedValue([first, second]);
    mocks.runClaimed.mockRejectedValueOnce(new Error("AUTHORITATIVE_PDF_NOT_PDF")).mockResolvedValueOnce(undefined);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runAuthoritativePdfArchiveWorkerOnce(new AuthoritativePdfProducerRegistry(), "test-worker")).resolves.toBe(2);

    expect(mocks.runClaimed).toHaveBeenCalledTimes(2);
    expect(mocks.runClaimed).toHaveBeenNthCalledWith(1, first, expect.any(AuthoritativePdfProducerRegistry));
    expect(mocks.runClaimed).toHaveBeenNthCalledWith(2, second, expect.any(AuthoritativePdfProducerRegistry));
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(2, "COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"failed":1'));
  });
});
