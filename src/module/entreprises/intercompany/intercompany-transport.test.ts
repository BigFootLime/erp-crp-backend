import { afterEach, describe, expect, it, vi } from "vitest";
import { intercompanyDigest, parseIntercompanyMessage, type IntercompanyMessage } from "./intercompany-message";
import { deliverIntercompanyMessage, intercompanyTransportConfiguration, signIntercompanyDelivery, verifyIntercompanyDelivery,
  type IntercompanyTransportConfiguration } from "./intercompany-transport";
import { selectCompanyBackgroundStarters } from "../runtime/company-background-profile";

const BUYER = "11111111-1111-4111-8111-111111111111";
const SELLER = "22222222-2222-4222-8222-222222222222";
const KEY = "ab".repeat(32); // Synthetic fixture key, never an operator credential.
const NOW = Date.parse("2026-10-27T10:00:00Z");
function message(): IntercompanyMessage {
  const payload = { schema_version: 1, order_reference: "TEST-1454" };
  return parseIntercompanyMessage({ id: "33333333-3333-4333-8333-333333333333", source_company_id: BUYER,
    destination_company_id: SELLER, environment: "cerp_test", kind: "PURCHASE_SUBMITTED", aggregate_id: "TEST-PO-1",
    revision: 1, occurred_at: new Date(NOW).toISOString(), payload_sha256: intercompanyDigest(payload), payload });
}
function configuration(company = SELLER): IntercompanyTransportConfiguration {
  return { enabled: true, company_id: company, environment: "cerp_test", peers: new Map([[company === SELLER ? BUYER : SELLER, {
    company_id: company === SELLER ? BUYER : SELLER, environment: "cerp_test", api_base_url: "https://fixture.invalid/companies/target/api/v1", signing_key_hex: KEY,
  }]]) };
}
function getter(headers: Record<string, string>) { const parsed = new Headers(headers); return (name: string) => parsed.get(name) ?? undefined; }
afterEach(() => vi.unstubAllEnvs());

describe("authenticated intercompany delivery", () => {
  it("hashes optional object properties as serialized JSON without accepting undefined array items", () => {
    expect(intercompanyDigest({ address: { city: "TEST", contact: undefined } })).toBe(intercompanyDigest({ address: { city: "TEST" } }));
    expect(() => intercompanyDigest([undefined])).toThrow("NOT_JSON");
  });
  it("accepts a fixed pair and canonical JSON regardless of key insertion order", () => {
    const event = message(); const headers = signIntercompanyDelivery(event, KEY, NOW);
    expect(verifyIntercompanyDelivery(configuration(), getter(headers), event, NOW)).toEqual(event);
    const reordered = { ...event, payload: { order_reference: "TEST-1454", schema_version: 1 } };
    expect(verifyIntercompanyDelivery(configuration(), getter(headers), reordered, NOW).id).toBe(event.id);
  });
  it.each(["source", "destination", "environment", "nonce", "signature", "time"])("rejects a tampered %s header", field => {
    const event = message(); const headers = signIntercompanyDelivery(event, KEY, NOW);
    const names = { source: "Source", destination: "Destination", environment: "Environment", nonce: "Nonce", signature: "Signature", time: "Time" };
    headers[`X-CERP-Intercompany-${names[field as keyof typeof names]}`] = "tampered";
    expect(() => verifyIntercompanyDelivery(configuration(), getter(headers), event, NOW)).toThrow();
  });
  it("rejects expired signatures and another environment or target", () => {
    const event = message(); const headers = signIntercompanyDelivery(event, KEY, NOW);
    expect(() => verifyIntercompanyDelivery(configuration(), getter(headers), event, NOW + 61001)).toThrow();
    expect(() => verifyIntercompanyDelivery({ ...configuration(), enabled: true, company_id: BUYER, environment: "cerp_test", peers: new Map() }, getter(headers), event, NOW)).toThrow();
    expect(() => verifyIntercompanyDelivery(configuration(), getter(headers), { ...event, environment: "cerp_prod" }, NOW)).toThrow();
  });
  it("rejects payload edits even if their new digest is recomputed", () => {
    const event = message(); const headers = signIntercompanyDelivery(event, KEY, NOW);
    const payload = { schema_version: 1, order_reference: "ANOTHER" };
    expect(() => verifyIntercompanyDelivery(configuration(), getter(headers), { ...event, payload }, NOW)).toThrow();
    expect(() => verifyIntercompanyDelivery(configuration(), getter(headers), { ...event, payload, payload_sha256: intercompanyDigest(payload) }, NOW)).toThrow();
  });
  it("does not expose an endpoint while transport is disabled", () => {
    expect(() => verifyIntercompanyDelivery({ enabled: false }, () => undefined, message())).toThrow();
  });
  it("uses only configured targets, forbids redirects and verifies the receiver receipt", async () => {
    const event = message();
    const fetcher = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ id: event.id, payload_sha256: event.payload_sha256, status: "PROCESSED" }), { status: 200 }));
    await deliverIntercompanyMessage(configuration(BUYER), event, fetcher as unknown as typeof fetch);
    expect(fetcher.mock.calls[0][0]).toBe("https://fixture.invalid/companies/target/api/v1/intercompany/messages");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", method: "POST" });
    const wrong = vi.fn(async () => new Response(JSON.stringify({ id: BUYER, payload_sha256: event.payload_sha256, status: "PROCESSED" }), { status: 200 }));
    await expect(deliverIntercompanyMessage(configuration(BUYER), event, wrong as unknown as typeof fetch)).rejects.toThrow("RECEIPT_MISMATCH");
  });
  it("limits response memory and refuses unconfigured peers", async () => {
    const fetcher = vi.fn(async () => new Response("x".repeat(17000), { status: 200 }));
    await expect(deliverIntercompanyMessage(configuration(BUYER), message(), fetcher as unknown as typeof fetch)).rejects.toThrow("TOO_LARGE");
    await expect(deliverIntercompanyMessage({ enabled: true, company_id: BUYER, environment: "cerp_test", peers: new Map() }, message(), fetcher as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe("operator configuration and worker isolation", () => {
  const env = () => ({ NODE_ENV: "production", CERP_BUSINESS_COMPANIES_ENABLED: "true", CERP_SHARED_DIRECTORY_ENABLED: "true",
    CERP_COMPANY_ID: BUYER, CERP_COMPANY_ENVIRONMENT: "cerp_test", CERP_INTERCOMPANY_ENABLED: "true",
    CERP_INTERCOMPANY_PEERS_JSON: JSON.stringify([{ company_id: SELLER, environment: "cerp_test", api_base_url: "https://fixture.invalid/api/v1", signing_key_hex: KEY }]) });
  it("requires the fixed company runtime and same-environment HTTPS peer", () => {
    expect(intercompanyTransportConfiguration(env()).enabled).toBe(true);
    expect(() => intercompanyTransportConfiguration({ ...env(), CERP_SHARED_DIRECTORY_ENABLED: "false" })).toThrow();
    for (const url of ["http://fixture.invalid/api/v1", "https://u:p@fixture.invalid/api/v1", "https://fixture.invalid/api/v1?token=x", "https://fixture.invalid/another"]) {
      const input = env(); input.CERP_INTERCOMPANY_PEERS_JSON = input.CERP_INTERCOMPANY_PEERS_JSON.replace("https://fixture.invalid/api/v1", url);
      expect(() => intercompanyTransportConfiguration(input)).toThrow();
    }
  });
  it("allows HTTP only for a test-only loopback fixture", () => {
    const input = env(); input.CERP_INTERCOMPANY_PEERS_JSON = input.CERP_INTERCOMPANY_PEERS_JSON.replace("https://fixture.invalid/api/v1", "http://127.0.0.1:15464/api/v1");
    expect(() => intercompanyTransportConfiguration(input)).toThrow();
    expect(intercompanyTransportConfiguration({ ...input, NODE_ENV: "test" }).enabled).toBe(true);
  });
  it("preserves industrial/legacy starters and excludes industrial tasks for commercial sites", () => {
    const finance = () => () => undefined; const stock = () => () => undefined; const planning = () => () => undefined;
    const entries = [{ key: "electronic-invoices", start: finance }, { key: "cump-projection", start: stock }, { key: "planning-forecast", start: planning }, { key: "future-industrial-task", start: planning }];
    expect(selectCompanyBackgroundStarters("COMMERCIAL", entries)).toEqual([finance]);
    expect(selectCompanyBackgroundStarters("INDUSTRIAL", entries)).toEqual([finance, stock, planning, planning]);
    expect(selectCompanyBackgroundStarters("LEGACY", entries)).toEqual([finance, stock, planning, planning]);
  });
});
