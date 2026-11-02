import { describe, expect, it, vi } from "vitest";

const query = vi.fn(async (sql: string) => {
  if (
    sql.includes("client_portal_contract_bindings binding") &&
    sql.includes("count(line.id)")
  )
    return { rows: [] };
  if (sql.includes("FROM public.client_contract_calls"))
    return { rows: [{ order_count: 0, total_ht: "0", total_ttc: "0" }] };
  if (sql.includes("FROM public.client_contract_forecasts"))
    return { rows: [] };
  if (sql.includes("FROM public.delivery_promise_roots")) return { rows: [] };
  if (sql.includes("client_portal_operational_notices")) return { rows: [] };
  if (sql.includes("FROM public.commande_client order_header"))
    return { rows: [] };
  return { rows: [{ count: 0 }] };
});

vi.mock("../../../config/database", () => ({ default: { query } }));

describe("client portal commercial cockpit scope", () => {
  it("uses explicit contract and delivery-site allow-lists, and reports unavailable data explicitly", async () => {
    const { repoGetPortalCommercialOverview } = await import(
      "./client-portal.repository"
    );
    const result = await repoGetPortalCommercialOverview({
      accountId: "11111111-1111-4111-8111-111111111111",
      clientId: "CLI",
      sessionEpoch: 1,
    });

    const sql = query.mock.calls
      .map(([statement]) => String(statement))
      .join("\n");
    expect(sql).toContain("client_portal_contract_bindings");
    expect(sql).toContain("client_portal_delivery_site_bindings");
    expect(sql).toContain("delivery_promise_site_evidence");
    expect(result.operational_notices).toEqual([]);
    expect(result.order_progress).toEqual([]);
  });
});
