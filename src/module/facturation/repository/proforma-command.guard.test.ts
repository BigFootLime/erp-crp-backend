import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  preview: vi.fn(),
  run: vi.fn(),
  tx: { query: vi.fn() },
}));

vi.mock("./financial-cutover-guard", () => ({
  assertFinancialCutoverEmissionAllowedTx: mocks.guard,
}));
vi.mock("./proforma-preview.repository", () => ({ buildProformaPreview: mocks.preview }));
vi.mock("./proforma-transaction.repository", () => ({
  runProformaCommand: async (args: { work: (tx: typeof mocks.tx, correlationId: string) => Promise<unknown> }) => args.work(mocks.tx, "guard-test"),
}));
vi.mock("./proforma-draft-content.repository", () => ({ persistProformaDraftContentTx: vi.fn() }));
vi.mock("./proforma-source.repository", () => ({ readProformaOrderSources: vi.fn() }));
vi.mock("../../../shared/authoritative-documents/authoritative-document.service", () => ({ queueCreationPdfArchive: vi.fn() }));
vi.mock("../services/proforma-document", () => ({ renderProformaDocument: vi.fn() }));

import { repoCreateProforma, repoIssueProforma } from "./proforma-command.repository";

describe("proforma cutover guard", () => {
  it("stops draft creation before preview, sequence allocation, or insert while preparation is active", async () => {
    mocks.guard.mockRejectedValue({ status: 409, code: "FINANCIAL_CUTOVER_SUSPENDED" });
    await expect(repoCreateProforma({
      actor: { userId: 7, requestId: "guard-test", path: "/proformas" },
      idempotencyKey: "proforma-guard-test",
      input: { preview_hash: "a".repeat(64) } as never,
    })).rejects.toMatchObject({ status: 409, code: "FINANCIAL_CUTOVER_SUSPENDED" });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.tx.query).not.toHaveBeenCalled();
  });

  it("stops issue of a pre-existing draft before it is read", async () => {
    mocks.guard.mockRejectedValue({ status: 409, code: "FINANCIAL_CUTOVER_SUSPENDED" });
    await expect(repoIssueProforma({
      actor: { userId: 7, requestId: "guard-test", path: "/proformas" },
      idempotencyKey: "proforma-guard-issue",
      id: "11111111-1111-4111-8111-111111111111",
      input: { expected_version: 1, preview_hash: "a".repeat(64), confirm: true } as never,
    })).rejects.toMatchObject({ status: 409, code: "FINANCIAL_CUTOVER_SUSPENDED" });
    expect(mocks.tx.query).not.toHaveBeenCalled();
  });
});
