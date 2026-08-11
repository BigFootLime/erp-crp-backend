import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../../../config/database", () => ({ default: { query } }));

import { repoDirectionCash, repoDirectionOrders } from "./direction-dashboard.repository";

const context = {
  period: { from: "2026-08-01", to: "2026-08-31" },
  asOf: "2026-08-11",
  limit: 20,
};

beforeEach(() => {
  query.mockReset();
});

describe("SOL-16 SQL contracts", () => {
  it("calcule l'OTIF au grain commande par atteinte cumulative de chaque quantité", async () => {
    query
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [] });

    await repoDirectionOrders(context);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("SUM(shipped_qty) OVER");
    expect(sql).toContain("cumulative_qty >= cl_ship.quantite");
    expect(sql).toContain("BOOL_AND(");
    expect(sql).toContain("completion_date <= delai_client");
    expect(sql).toContain("bl.statut = ANY");
    expect(sql).not.toContain("CANCELLED'");
  });

  it("applique site, client et devise dans le SQL paramétré", async () => {
    const siteId = "11111111-1111-4111-8111-111111111111";
    query
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [] });

    await repoDirectionOrders({
      ...context,
      siteId,
      clientId: "client-1",
      currency: "EUR",
    });

    const sql = String(query.mock.calls[0]?.[0]);
    const values = query.mock.calls[0]?.[1] as unknown[];
    expect(sql).toContain("selected_site.site_id");
    expect(sql).toContain("cc.client_id = $");
    expect(sql).toContain("UPPER(NULLIF(BTRIM(c.devise), '')) = $");
    expect(values).toEqual(expect.arrayContaining([siteId, "client-1", "EUR"]));
  });

  it("ne remplace pas une échéance de facture manquante par la date d'émission pour le cash", async () => {
    query.mockResolvedValueOnce({ rows: [{}] });

    await repoDirectionCash(context);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("b.date_echeance IS NOT NULL");
    expect(sql).toContain("b.date_echeance BETWEEN");
    expect(sql).toContain("b.balance_ttc > 0");
    expect(sql).toContain("settled AS");
    expect(sql).toContain("credited AS");
  });
});
