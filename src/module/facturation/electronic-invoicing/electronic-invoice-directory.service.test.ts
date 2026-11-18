import { describe, expect, it, vi } from "vitest";
import { listElectronicInvoiceDirectoryEntries } from "./electronic-invoice-directory.service";
import { SuperPdpProviderError } from "./providers/super-pdp/super-pdp.client";

const directory = vi.hoisted(() => vi.fn());
vi.mock("./providers/super-pdp/super-pdp.client", async (importOriginal) => ({
  ...await importOriginal<typeof import("./providers/super-pdp/super-pdp.client")>(),
  SuperPdpClient: class { listFrenchDirectoryEntries = directory; },
}));

describe("annuaire électronique", () => {
  it("identifies a provider interruption without treating it as an empty directory", async () => {
    directory.mockRejectedValueOnce(new SuperPdpProviderError({
      code: "SUPER_PDP_NETWORK_ERROR", message: "Network unavailable", httpStatus: null,
    }));
    await expect(listElectronicInvoiceDirectoryEntries("123456789")).rejects.toMatchObject({
      status: 503, code: "EINVOICE_DIRECTORY_UNAVAILABLE",
    });
  });

  it("preserves a successful empty lookup", async () => {
    directory.mockResolvedValueOnce([]);
    await expect(listElectronicInvoiceDirectoryEntries("123456789")).resolves.toEqual([]);
  });
});
