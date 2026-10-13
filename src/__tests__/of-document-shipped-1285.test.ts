import { describe, expect, it, vi } from "vitest";
import { OF_DOCUMENT_SHIPPED_QUANTITY_SQL, readOfDocumentShippedQuantity } from "../module/production/repository/of-document-shipped.repository";
import type { DbQueryer } from "../module/production/repository/of-versioning.repository";

describe("OF PDF delivered counter", () => {
  it("keeps stock-only production at zero delivered, even when twenty goods were manufactured", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ shipped_quantity: 0, quantite_bonne: 20 }] });
    expect(await readOfDocumentShippedQuantity(95, { query } as unknown as DbQueryer)).toBe(0);
    expect(query).toHaveBeenCalledWith(OF_DOCUMENT_SHIPPED_QUANTITY_SQL, [95]);
  });
  it("uses the sum of actual shipped allocations rather than good quantities", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ shipped_quantity: "7", quantite_bonne: 20 }] });
    expect(await readOfDocumentShippedQuantity(95, { query } as unknown as DbQueryer)).toBe(7);
  });
  it("excludes prepared and cancelled BLs, other clients and assembly components at the SQL source", () => {
    expect(OF_DOCUMENT_SHIPPED_QUANTITY_SQL).toContain("('SHIPPED','DELIVERED')");
    expect(OF_DOCUMENT_SHIPPED_QUANTITY_SQL).toContain("commande.client_id IS NOT DISTINCT FROM courant.client_id");
    expect(OF_DOCUMENT_SHIPPED_QUANTITY_SQL).toContain("courant.parent_of_id IS NULL");
    expect(OF_DOCUMENT_SHIPPED_QUANTITY_SQL).toContain("COALESCE(allocation.article_ref_id,ligne.article_id) = courant.article_id");
    expect(OF_DOCUMENT_SHIPPED_QUANTITY_SQL).not.toContain("quantite_bonne");
  });
  it("rejects corrupt shipping totals instead of producing a plausible PDF", async () => {
    for (const value of [-1, "NaN"]) {
      const query = vi.fn().mockResolvedValue({ rows: [{ shipped_quantity: value }] });
      await expect(readOfDocumentShippedQuantity(95, { query } as unknown as DbQueryer)).rejects.toThrow(/Invalid/);
    }
  });
});
