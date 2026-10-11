import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qualifyIssuerElectronicAddress } from "./electronic-invoice-issuer.repository";

const query = vi.fn();
const client = { query } as unknown as PoolClient;
const params = { issuerId: "issuer", scheme: "0225", value: "999999998", identifier: "0225:999999998", actorId: 7 };
const prior = { mention_set_id: "legal-v1", effective_from: "2026-01-01", effective_to: "2027-01-01", today: "2026-10-11", electronic_address_directory_entry_id: null, verified_at: null };
beforeEach(() => query.mockReset());

describe("issuer routing qualification in the caller transaction", () => {
  it("creates a dated version preserving the next period and all legal identity fields", async () => {
    query.mockResolvedValueOnce({ rows: [prior] }).mockResolvedValueOnce({ rows: [], rowCount: 1 }).mockResolvedValueOnce({ rows: [{ verified_at: "2026-10-11T12:00:00Z" }] });
    expect(await qualifyIssuerElectronicAddress(client, params)).toMatchObject({ rows: [{ verified_at: "2026-10-11T12:00:00Z" }] });
    expect(query.mock.calls[1]).toEqual([expect.stringContaining("SET effective_to = CURRENT_DATE"), ["legal-v1"]]);
    expect(query.mock.calls[2]).toEqual([expect.stringContaining("INSERT INTO public.finance_legal_mentions"), ["legal-v1", "0225", "999999998", "0225:999999998", 7, "2027-01-01"]]);
    expect(query.mock.calls[2][0]).toContain("m.siret");
    expect(query.mock.calls[2][0]).toContain("m.extra_mentions");
    expect(query.mock.calls[2][0]).toContain("max(v.version) + 1");
    expect(query.mock.calls.some(([sql]) => /finance_documents|public.factures/.test(sql))).toBe(false);
  });
  it("never creates another version for the same already qualified address", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...prior, electronic_address_directory_entry_id: params.identifier, verified_at: "2026-09-11T12:00:00Z" }] });
    await expect(qualifyIssuerElectronicAddress(client, params)).resolves.toMatchObject({ rows: [{ verified_at: "2026-09-11T12:00:00Z" }] });
    expect(query).toHaveBeenCalledOnce();
  });
  it("qualifies a new daily version for the first time without a zero-length period", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...prior, effective_from: prior.today }] }).mockResolvedValueOnce({ rows: [{ verified_at: "2026-10-11T12:00:00Z" }] });
    await qualifyIssuerElectronicAddress(client, params);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain("WHERE mention_set_id = $1::uuid");
    expect(query.mock.calls[1][0]).not.toContain("effective_from");
  });
  it("refuses overwriting a different address already qualified today", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...prior, effective_from: prior.today, verified_at: "2026-10-11T10:00:00Z", electronic_address_directory_entry_id: "0225:other" }] });
    await expect(qualifyIssuerElectronicAddress(client, params)).rejects.toMatchObject({ code: "FINANCE_ISSUER_ROUTING_ALREADY_QUALIFIED_TODAY" });
    expect(query).toHaveBeenCalledOnce();
  });
  it("rejects a missing applicable legal version before writing", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(qualifyIssuerElectronicAddress(client, params)).rejects.toMatchObject({ status: 409 });
    expect(query).toHaveBeenCalledOnce();
  });
});
