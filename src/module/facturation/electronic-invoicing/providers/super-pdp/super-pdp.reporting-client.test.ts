import { describe, expect, it, vi } from "vitest";

import {
  SuperPdpClient,
  type SuperPdpAccessTokenProvider,
  type SuperPdpClientConfiguration,
} from "./super-pdp.client";

const configuration: SuperPdpClientConfiguration = {
  environment: "sandbox",
  baseUrl: "https://api.superpdp.tech",
  oauthMode: "client_credentials",
  clientId: "test-client",
  clientSecret: "test-secret",
  timeoutMs: 5_000,
};

const tokenProvider: SuperPdpAccessTokenProvider = {
  mode: "client_credentials",
  configured: () => true,
  accessToken: async () => "opaque-test-token",
};

describe("SUPERPDP e-reporting contract", () => {
  it("posts foreign transactions and payments to the pinned beta resources", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 501 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 502 }] }), { status: 200 }));
    const client = new SuperPdpClient(configuration, fetcher, Date.now, tokenProvider);

    await client.createB2BIntInvoices({ data: [{ number: "DE-18" }], correlationId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "transaction-501" });
    await client.createB2BIntPayments({ data: [{ invoice_number: "DE-18" }], correlationId: "22222222-2222-4222-8222-222222222222", idempotencyKey: "payment-502" });

    expect(fetcher.mock.calls[0]?.[0].toString()).toBe("https://api.superpdp.tech/v1.beta/b2bint_invoices");
    expect(fetcher.mock.calls[1]?.[0].toString()).toBe("https://api.superpdp.tech/v1.beta/b2bint_payments");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ data: [{ number: "DE-18" }] });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe("transaction-501");
  });

  it("paginates observed regulatory periods without interpreting provider events", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{
        id: 42,
        company_id: 91,
        kind: "transaction",
        role_code: "BY",
        start_period: "2027-09-01",
        end_period: "2027-09-10",
        events: [{ code: "provider-owned" }],
      }],
      has_more: false,
    }), { status: 200 }));
    const client = new SuperPdpClient(configuration, fetcher, Date.now, tokenProvider);
    const result = await client.listEReportingPeriods({ roleCode: "BY", startingAfterId: 21, limit: 100 });
    expect(result.data[0]).toMatchObject({ id: 42, kind: "transaction", role_code: "BY" });
    expect(fetcher.mock.calls[0]?.[0].toString()).toContain("/v1.beta/ereportings?order=asc&limit=100&role_code=BY&starting_after_id=21");
  });
});
