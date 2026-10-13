import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { releasePrelaunchPurchaseAllocationsTx } from "./of-prelaunch-cancellation.repository";

const clear = { started: false, stock: false, planning: false, grouped: false, children: false };
function fixture(state: unknown = clear, allocations = [{ id: "need-fixture", purchase_order_id: "purchase-fixture", quantity: 1326 }]) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes(" AS started") ? state ? [state] : [] : sql.includes("FOR UPDATE OF b") ? allocations : [] }));
  return { tx: { query } as unknown as Pick<PoolClient, "query">, query };
}
describe("Explicit cancellation of an unused prelaunch OF", () => {
  it("releases the purchase assignment while preserving a received purchase and all physical stock", async () => {
    const { tx, query } = fixture();
    expect(await releasePrelaunchPurchaseAllocationsTx(tx, 92)).toEqual([{ id: "need-fixture", purchase_order_id: "purchase-fixture", quantity: 1326 }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET annule=true"), [["need-fixture"]]);
    expect(query.mock.calls.some(([sql]) => /(?:UPDATE|INSERT INTO|DELETE FROM).*public\.(?:stock_|lots|reception)/s.test(sql))).toBe(false);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("SET annule=true"), [["need-fixture"]]);
  });
  it.each(["started", "stock", "planning", "grouped", "children"])("preserves commitments when %s is present", key => {
    const { tx, query } = fixture({ ...clear, [key]: true });
    return expect(releasePrelaunchPurchaseAllocationsTx(tx, 92)).rejects.toMatchObject({ code: "OF_CANCELLATION_COMMITMENTS" }).then(() => expect(query).toHaveBeenCalledOnce());
  });
  it.each([null, {}, { ...clear, stock: null }])("fails closed if the commitment check is unavailable: %j", async state => {
    const { tx, query } = fixture(state);
    await expect(releasePrelaunchPurchaseAllocationsTx(tx, 92)).rejects.toMatchObject({ code: "OF_CANCELLATION_CHECK_UNAVAILABLE" });
    expect(query).toHaveBeenCalledOnce();
  });
  it("does not write on replay once the assignments are cancelled", async () => {
    const { tx, query } = fixture(clear, []);
    expect(await releasePrelaunchPurchaseAllocationsTx(tx, 92)).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
