import { describe, expect, it } from "vitest";

import { canonicalStockCommandPayload, hashStockCommand } from "./stock-command";

describe("stock command hashing", () => {
  it("is stable across object key order", () => {
    const left = hashStockCommand("POST", { id: "m-1", nested: { qty: 4, lot: null } });
    const right = hashStockCommand("POST", { nested: { lot: null, qty: 4 }, id: "m-1" });
    expect(left).toBe(right);
  });

  it("keeps array order because stock line order is semantic", () => {
    const left = hashStockCommand("CREATE", { lines: [{ qty: 1 }, { qty: 2 }] });
    const right = hashStockCommand("CREATE", { lines: [{ qty: 2 }, { qty: 1 }] });
    expect(left).not.toBe(right);
  });

  it("omits undefined values but retains null", () => {
    expect(canonicalStockCommandPayload("CREATE", { a: undefined, b: null })).toBe(
      '{"command":"CREATE","payload":{"b":null}}'
    );
  });
});
