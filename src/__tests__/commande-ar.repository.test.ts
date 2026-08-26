import { describe, expect, it, vi } from "vitest";

import {
  formatCommandeArReference,
  repoFindReusableCommandeArDraft,
  repoReserveCommandeArVersion,
} from "../module/commande-client/repository/commande-ar.repository";

describe("commande AR version repository guards", () => {
  it("formats the stable series/version reference", () => {
    expect(formatCommandeArReference(1, 1)).toBe("AR-00000001-v1");
    expect(formatCommandeArReference(98765432, 12)).toBe("AR-98765432-v12");
  });

  it("reuses an unsent failed draft instead of silently creating another version", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await repoFindReusableCommandeArDraft({
      tx: { query },
      commande_id: 42,
      content_fingerprint: "a".repeat(64),
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("ar.status IN ('GENERATED', 'FAILED')");
    expect(sql).toContain("FOR UPDATE OF ar");
  });

  it("allocates a version from the locked series counter rather than MAX()+1", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ series_number: 18, next_version_number: 4 }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await repoReserveCommandeArVersion({ tx: { query }, commande_id: 42 });

    expect(result).toEqual({ series_number: 18, version_number: 4, reference: "AR-00000018-v4" });
    expect(String(query.mock.calls[0]?.[0])).toContain("FOR UPDATE");
    expect(String(query.mock.calls[0]?.[0])).not.toContain("MAX(");
    expect(query.mock.calls[1]?.[1]).toEqual([42, 5]);
  });
});
