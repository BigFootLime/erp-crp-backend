import { describe, expect, it } from "vitest";

import { runtimeListenHost } from "./runtime-listen-host";

describe("runtime listener host", () => {
  it("forces every leader listener to loopback regardless of managed or E2E environment", () => {
    expect(runtimeListenHost("leader", {})).toBe("127.0.0.1");
    expect(runtimeListenHost("leader", { CERP_MANAGED_TEST_ID: "test" })).toBe("127.0.0.1");
    expect(runtimeListenHost("leader", { CERP_E2E_ISOLATED: "1", CERP_E2E_MANAGED_STACK: "1", CERP_E2E_CONTAINER: "1" })).toBe("127.0.0.1");
  });

  it("preserves the existing routed API listener matrix for off and always", () => {
    expect(runtimeListenHost("always", {})).toBe("0.0.0.0");
    expect(runtimeListenHost("off", {})).toBe("0.0.0.0");
    expect(runtimeListenHost("always", { CERP_MANAGED_TEST_ID: "test" })).toBe("127.0.0.1");
    expect(runtimeListenHost("off", { CERP_MANAGED_TEST_ID: "test" })).toBe("127.0.0.1");
    const managedContainer = { CERP_E2E_ISOLATED: "1", CERP_E2E_MANAGED_STACK: "1", CERP_E2E_CONTAINER: "1" };
    expect(runtimeListenHost("always", managedContainer)).toBe("0.0.0.0");
    expect(runtimeListenHost("off", managedContainer)).toBe("0.0.0.0");
  });
});
