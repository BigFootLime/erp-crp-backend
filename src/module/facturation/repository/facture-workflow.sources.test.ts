import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: { query: mocks.query } }));
import { eligibleSourcesQuerySchema } from "../validators/workflow.validators";
import { repoListEligibleFactureSources } from "./facture-workflow.repository";
const delivery = "a142a4b4-40f5-4fe1-8c42-2766cf19f5dd";

describe("#1140 contextual invoice source reads", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [] });
  });
  it.each(["", "48", "../../clients", "a142a4b4-40f5-4fe1-8c42-2766cf19f5dd OR true"])("rejects invalid delivery filter %s before SQL", invalid => {
    expect(eligibleSourcesQuerySchema.safeParse({ livraison_id: invalid }).success).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("retains strict unknown-key rejection", () => {
    expect(eligibleSourcesQuerySchema.safeParse({ livraison_id: delivery, include_internal: true }).success).toBe(false);
  });
  it("applies one parameterized delivery filter to both count and page, with shipment/internal eligibility", async () => {
    const reply = await repoListEligibleFactureSources(eligibleSourcesQuerySchema.parse({ livraison_id: delivery, page: 2, pageSize: 100 }));
    expect(reply.items).toEqual([]);
    for (const index of [1, 2]) {
      const [sql, values] = mocks.query.mock.calls[index];
      expect(sql).toContain("bl.id = $1::uuid");
      expect(sql).toContain("bl.statut IN ('SHIPPED','DELIVERED')");
      expect(sql).toContain("<> 'INTERNE'");
      expect(sql).not.toContain(delivery);
      expect(values).toEqual(index === 1 ? [delivery] : [delivery, 100, 100]);
    }
  });
  it("intersects delivery with client, order and affair instead of replacing their scope", async () => {
    await repoListEligibleFactureSources(eligibleSourcesQuerySchema.parse({ livraison_id: delivery, client_id: "195", commande_id: 112, affaire_id: 193 }));
    for (const index of [1, 2]) {
      const [sql, values] = mocks.query.mock.calls[index];
      expect(sql).toContain("bl.client_id = $1");
      expect(sql).toContain("bl.commande_id = $2::bigint");
      expect(sql).toContain("bl.id = $3::uuid");
      expect(sql).toContain("bl.affaire_id = $4::bigint");
      expect(values.slice(0, 4)).toEqual(["195", 112, delivery, 193]);
    }
    expect(mocks.query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/.test(sql))).toBe(true);
  });
});
