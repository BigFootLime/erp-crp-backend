import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
const acl = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../../ged/services/ged-parent-authorization.service", () => ({ assertGedVersionParentReadable: acl.read }));
import { linkCutoverEvidenceTx } from "./evidence.repository";

const input = { batchId: "91000000-0000-4000-8000-000000000001", rowId: "91000000-0000-4000-8000-000000000002", fieldKey: "priceEvidence", gedDocumentId: "91000000-0000-4000-8000-000000000003", actorId: 1 };
const current = { id: input.gedDocumentId, version_id: "91000000-0000-4000-8000-000000000004", title: "Commande", original_name: "commande.pdf", sha256: "a".repeat(64), size_bytes: "123" };
describe("cutover GED evidence snapshots", () => {
  beforeEach(() => { vi.clearAllMocks(); acl.read.mockResolvedValue(undefined); });
  it("returns the original frozen version on an attachment retry after a GED version change", async () => {
    const frozen = { document_id: current.id, current_version_id: "91000000-0000-4000-8000-000000000005", title: "Commande initiale", original_name: "initial.pdf", sha256: "b".repeat(64), size_bytes: "100" };
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ domain: "SALES_ORDER" }] }).mockResolvedValueOnce({ rows: [current] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ snapshot: frozen }] });
    const result = await linkCutoverEvidenceTx({ query } as unknown as PoolClient, input);
    expect(result).toEqual(frozen);
    expect(result.current_version_id).not.toBe(current.version_id);
    expect(acl.read).toHaveBeenCalledWith(input.actorId, input.gedDocumentId);
  });
  it("does not attach a document whose native GED parent access is denied", async () => {
    acl.read.mockRejectedValueOnce(new Error("denied"));
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ domain: "SALES_ORDER" }] }).mockResolvedValueOnce({ rows: [current] });
    await expect(linkCutoverEvidenceTx({ query } as unknown as PoolClient, input)).rejects.toThrow("denied");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
