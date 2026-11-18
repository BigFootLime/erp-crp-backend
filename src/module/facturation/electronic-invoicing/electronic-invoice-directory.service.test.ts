import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), replay: vi.fn(), persist: vi.fn(), entries: vi.fn() }));
vi.mock("./electronic-invoice-directory.repository", () => ({ readDirectoryVerificationResource: mocks.read, findDirectoryVerificationReplay: mocks.replay, persistDirectoryVerification: mocks.persist }));
vi.mock("./providers/super-pdp/super-pdp.client", async (importOriginal) => ({
  ...await importOriginal<typeof import("./providers/super-pdp/super-pdp.client")>(),
  loadSuperPdpConfiguration: () => ({}),
  SuperPdpClient: class { listFrenchDirectoryEntries = mocks.entries },
}));
import { listElectronicInvoiceDirectoryEntries, verifyElectronicInvoiceDirectoryAddress } from "./electronic-invoice-directory.service";
import { SuperPdpProviderError } from "./providers/super-pdp/super-pdp.client";
const params = { resourceType: "ISSUER" as const, resourceId: "issuer", identifier: "0225:999999998", expectedUpdatedAt: "2026-01-01T00:00:00Z", idempotencyKey: "request-1", audit: { user_id: 7, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null } };
const entry = { identifier: params.identifier, is_active: true, company: { number: "999999998" } };
beforeEach(() => { vi.resetAllMocks(); mocks.read.mockResolvedValue({ siren: "999999998" }); mocks.replay.mockResolvedValue(null); mocks.persist.mockResolvedValue({ verified: true }); });
describe("issuer directory qualification", () => {
  it("writes only after confirming the exact active SIREN/address pair", async () => {
    mocks.entries.mockResolvedValue([entry]);
    await verifyElectronicInvoiceDirectoryAddress(params);
    expect(mocks.entries).toHaveBeenCalledWith("999999998");
    expect(mocks.persist).toHaveBeenCalledWith({ ...params, siren: "999999998" });
  });
  it.each([[], [{ ...entry, is_active: false }], [{ ...entry, company: { number: "111111111" } }]].map((entries) => ({ entries })))("never qualifies absent, inactive or different-issuer entries ($entries)", async ({ entries }) => {
    mocks.entries.mockResolvedValue(entries);
    await expect(verifyElectronicInvoiceDirectoryAddress(params)).rejects.toMatchObject({ status: 422 });
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("replays a saved command without making another provider call", async () => {
    mocks.replay.mockResolvedValue({ idempotent_replay: true });
    await expect(verifyElectronicInvoiceDirectoryAddress(params)).resolves.toEqual({ idempotent_replay: true });
    expect(mocks.entries).not.toHaveBeenCalled(); expect(mocks.persist).not.toHaveBeenCalled();
  });
});

describe("availability of the invoicing directory", () => {
  it("reports a provider interruption and preserves a successful empty lookup", async () => {
    mocks.entries.mockRejectedValueOnce(new SuperPdpProviderError({
      code: "SUPER_PDP_NETWORK_ERROR", message: "Network unavailable", httpStatus: null,
    }));
    await expect(listElectronicInvoiceDirectoryEntries("123456789")).rejects.toMatchObject({
      status: 503, code: "EINVOICE_DIRECTORY_UNAVAILABLE",
    });
    mocks.entries.mockResolvedValueOnce([]);
    await expect(listElectronicInvoiceDirectoryEntries("123456789")).resolves.toEqual([]);
  });
});
