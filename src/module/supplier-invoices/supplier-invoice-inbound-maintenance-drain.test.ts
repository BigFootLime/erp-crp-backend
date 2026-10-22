import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfiguration: vi.fn(() => ({ clientId: "test-client", clientSecret: "test-secret" })),
}));

vi.mock("../facturation/electronic-invoicing/providers/super-pdp/super-pdp.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../facturation/electronic-invoicing/providers/super-pdp/super-pdp.client")>()),
  loadSuperPdpConfiguration: mocks.loadConfiguration,
}));

import { startSupplierInvoiceMaintenance } from "./supplier-invoice-inbound.service";

describe("supplier invoice maintenance drain", () => {
  const originalProvider = process.env.EINVOICE_PROVIDER;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.EINVOICE_PROVIDER = "super-pdp";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalProvider === undefined) delete process.env.EINVOICE_PROVIDER;
    else process.env.EINVOICE_PROVIDER = originalProvider;
  });

  it("waits for the active provider-status domain cycle and never starts a later cycle after stop", async () => {
    let releaseStatuses: ((value: number) => void) | undefined;
    const flushProviderStatuses = vi.fn(() => new Promise<number>((resolve) => { releaseStatuses = resolve; }));
    const syncInbound = vi.fn().mockResolvedValue(0);
    const stop = startSupplierInvoiceMaintenance({
      flushProviderStatuses,
      syncInbound,
      intervalMs: 1_000,
      now: () => 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(flushProviderStatuses).toHaveBeenCalledOnce();

    const stopping = stop();
    let settled = false;
    void Promise.resolve(stopping).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flushProviderStatuses).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    releaseStatuses?.(0);
    await stopping;
    expect(syncInbound).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flushProviderStatuses).toHaveBeenCalledOnce();
  });
});
