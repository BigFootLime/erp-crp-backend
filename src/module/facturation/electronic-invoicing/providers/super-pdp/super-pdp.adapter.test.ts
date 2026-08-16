import { describe, expect, it, vi } from "vitest";

import type { ElectronicInvoiceSourceDocument } from "../../electronic-invoice.domain";
import { SuperPdpAdapter } from "./super-pdp.adapter";
import { SuperPdpClient, loadSuperPdpConfiguration, type SuperPdpClientConfiguration } from "./super-pdp.client";
import { buildSuperPdpEn16931Invoice } from "./super-pdp.en16931";

const source: ElectronicInvoiceSourceDocument = {
  invoiceId: 42,
  creditNoteId: null,
  documentType: "INVOICE",
  legalNumber: "FA-2026-0042",
  issueDate: "2026-08-16",
  dueDate: "2026-09-15",
  currency: "EUR",
  issuerSnapshot: {
    siren: "123456789",
    siret: "12345678900011",
    vat_number: "FR00123456789",
    company_name: "Croix Rousse Précision",
    address_line_1: "1 rue de la Précision",
    postal_code: "69004",
    city: "Lyon",
    country: "FR",
    iban: "FR7612345678901234567890123",
  },
  customerSnapshot: {
    siret: "98765432100011",
    company_name: "Client industriel",
    billing_address: { street: "2 rue du Client", postal_code: "69003", city: "Lyon", country: "France" },
  },
  lines: [{
    id: 1,
    description: "Pièce usinée",
    item_code: "P-001",
    quantity: "2",
    unit: "unité",
    unit_price_ex_tax: "50.00",
    discount_percent: "0",
    vat_rate: "20",
    total_ex_tax: "100.00",
    total_incl_tax: "120.00",
  }],
  totals: { net: "100.00", tax: "20.00", gross: "120.00" },
};

const configuration: SuperPdpClientConfiguration = {
  environment: "sandbox",
  baseUrl: "https://api.superpdp.tech",
  oauthMode: "client_credentials",
  clientId: "sandbox-client",
  clientSecret: "sandbox-secret-never-log",
  timeoutMs: 5_000,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("SUPER PDP adapter", () => {
  it("builds a source-backed EN16931 model and rejects unqualified zero VAT", () => {
    const result = buildSuperPdpEn16931Invoice(source);
    expect(result).toMatchObject({
      number: "FA-2026-0042",
      currency_code: "EUR",
      seller: { name: "Croix Rousse Précision" },
      buyer: { name: "Client industriel" },
      totals: { total_without_vat: "100.00", amount_due_for_payment: "120.00" },
    });
    const line = (result.lines as Array<Record<string, unknown>>)[0];
    expect(line).toMatchObject({
      invoiced_quantity_code: "C62",
      net_amount: "100",
    });
    expect(line).not.toHaveProperty("line_vat_amount");
    expect(line).not.toHaveProperty("line_with_vat_net_amount");
    expect(() => buildSuperPdpEn16931Invoice({
      ...source,
      lines: [{ ...source.lines[0], vat_rate: "0" }],
    })).toThrowError(/catégorie et le motif de TVA/i);
  });

  it("keeps authorization-code mode blocked until a tenant vault is injected", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new SuperPdpClient({ ...configuration, oauthMode: "authorization_code", clientSecret: null }, fetcher);
    const diagnostic = await client.diagnose();
    expect(diagnostic).toMatchObject({
      configured: false,
      authenticated: false,
      failure_code: "SUPER_PDP_TENANT_VAULT_REQUIRED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("authenticates, converts, submits and reconciles only official lifecycle events", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/oauth2/token") {
        return jsonResponse({ access_token: "access-token", token_type: "Bearer", expires_in: 300 });
      }
      if (url.pathname === "/v1.beta/oauth2_sessions/me") {
        return jsonResponse({
          client_id: "sandbox-client",
          created_at: "2026-08-16T10:00:00.000Z",
          company_verification_status: "verified",
        });
      }
      if (url.pathname === "/v1.beta/invoices/convert") {
        return new Response("<?xml version=\"1.0\"?><Invoice xmlns=\"urn:oasis:names:specification:ubl:schema:xsd:Invoice-2\"/>", {
          status: 200,
          headers: { "Content-Type": "application/xml" },
        });
      }
      if (url.pathname === "/v1.beta/invoices" && init?.method !== "POST") {
        return jsonResponse({ data: [], count: 0, has_before: false, has_after: false });
      }
      if (url.pathname === "/v1.beta/invoices" && init?.method === "POST") {
        return jsonResponse({
          id: 77,
          company_id: 12,
          created_at: "2026-08-16T10:02:00.000Z",
          direction: "out",
          external_id: "52bb2f7e-51ba-4b8d-a630-c6b4a43da9ad",
          events: [{
            id: 700,
            invoice_id: 77,
            status_code: "api:uploaded",
            status_text: "Uploaded",
            created_at: "2026-08-16T10:02:00.000Z",
          }],
        }, 201);
      }
      if (url.pathname === "/v1.beta/invoices/77") {
        return jsonResponse({
          id: 77,
          company_id: 12,
          created_at: "2026-08-16T10:02:00.000Z",
          direction: "out",
          external_id: "52bb2f7e-51ba-4b8d-a630-c6b4a43da9ad",
          events: [{
            id: 701,
            invoice_id: 77,
            status_code: "fr:200",
            status_text: "Déposée",
            created_at: "2026-08-16T10:03:00.000Z",
          }],
        });
      }
      throw new Error(`Unexpected SUPER PDP call: ${url.pathname}`);
    });
    const adapter = new SuperPdpAdapter(new SuperPdpClient(configuration, fetcher));
    expect(await adapter.diagnose()).toMatchObject({ authenticated: true, failureCode: null });
    const prepared = await adapter.prepare(source, "UBL");
    expect(prepared.content.toString("utf8")).toContain("<Invoice");
    const receipt = await adapter.submit({
      localDocumentId: "52bb2f7e-51ba-4b8d-a630-c6b4a43da9ad",
      invoiceId: 42,
      creditNoteId: null,
      documentType: "INVOICE",
      format: "UBL",
      filename: prepared.filename,
      contentType: prepared.contentType,
      content: prepared.content,
      contentSha256: "a".repeat(64),
      idempotencyKey: "cerp-einvoice-52bb2f7e-51ba-4b8d-a630-c6b4a43da9ad",
      correlationId: "1da6663b-7c2b-4269-80b2-779b39a65d2a",
      attachments: [],
    });
    expect(receipt).toMatchObject({ providerDocumentId: "77", statusCode: null });
    const submissionCall = fetcher.mock.calls.find(([input, init]) =>
      new URL(String(input)).pathname === "/v1.beta/invoices" && init?.method === "POST"
    );
    expect(submissionCall).toBeDefined();
    const submissionUrl = new URL(String(submissionCall?.[0]));
    expect(submissionUrl.searchParams.get("external_id")).toBe("52bb2f7e-51ba-4b8d-a630-c6b4a43da9ad");
    expect(submissionUrl.searchParams.has("processing_rule")).toBe(false);
    expect(submissionUrl.searchParams.has("disable_pre_check")).toBe(false);
    const event = await adapter.retrieve("77", "correlation-1", {
      direction: "OUTBOUND",
      documentType: "INVOICE",
      format: "UBL",
      invoiceId: 42,
      creditNoteId: null,
      documentSha256: "a".repeat(64),
    });
    expect(event).toMatchObject({ providerEventId: "701", statusCode: 200, invoiceId: 42 });

    const tokenCalls = fetcher.mock.calls.filter(([input]) => new URL(String(input)).pathname === "/oauth2/token");
    expect(tokenCalls).toHaveLength(1);
    const nonTokenHeaders = fetcher.mock.calls
      .filter(([input]) => new URL(String(input)).pathname !== "/oauth2/token")
      .map(([, init]) => JSON.stringify(init?.headers ?? {}));
    expect(nonTokenHeaders.join(" ")).not.toContain("sandbox-secret-never-log");
  });

  it("recovers a retry by external_id without creating a duplicate invoice", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/oauth2/token") {
        return jsonResponse({ access_token: "access-token", token_type: "Bearer", expires_in: 300 });
      }
      if (url.pathname === "/v1.beta/invoices" && init?.method !== "POST") {
        return jsonResponse({
          data: [{
            id: 88,
            company_id: 12,
            created_at: "2026-08-16T11:00:00.000Z",
            direction: "out",
            external_id: "52bb2f7e-51ba-4b8d-a630-c6b4a43da9ad",
          }],
          count: 1,
          has_before: false,
          has_after: false,
        });
      }
      throw new Error(`Unexpected call ${url.pathname}`);
    });
    const client = new SuperPdpClient(configuration, fetcher);
    const result = await client.submit({
      localDocumentId: "52bb2f7e-51ba-4b8d-a630-c6b4a43da9ad",
      idempotencyKey: "stable-key",
      correlationId: "correlation",
      content: Buffer.from("<Invoice/>", "utf8"),
      contentType: "application/xml",
    });
    expect(result).toMatchObject({ replayed: true, invoice: { id: 88 } });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST" && init.body instanceof ArrayBuffer)).toBe(false);
  });

  it("loads no secret value into metadata and validates environment settings", () => {
    const loaded = loadSuperPdpConfiguration({
      NODE_ENV: "test",
      EINVOICE_ENVIRONMENT: "sandbox",
      SUPER_PDP_OAUTH_MODE: "client_credentials",
      SUPER_PDP_CLIENT_ID: "id",
      SUPER_PDP_CLIENT_SECRET: "secret",
      SUPER_PDP_BASE_URL: "http://127.0.0.1:9876",
    });
    expect(loaded).toMatchObject({ environment: "sandbox", oauthMode: "client_credentials" });
    expect(() => loadSuperPdpConfiguration({ SUPER_PDP_BASE_URL: "https://attacker.example" })).toThrowError(/official API/i);
    expect(() => loadSuperPdpConfiguration({ EINVOICE_PROVIDER: "super-pdp" })).toThrowError(/EINVOICE_ENVIRONMENT/);
  });
});
