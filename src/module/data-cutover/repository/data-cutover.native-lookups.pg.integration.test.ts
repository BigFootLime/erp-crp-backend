import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Queries must compile against the real native schema; this suite is opt-in
// and refuses anything other than the dedicated schema-only local clone.
const url = process.env.CERP_NATIVE_CUTOVER_LOOKUP_URL;
const describePg = url ? describe : describe.skip;
let db: Pool;
let appPool: Pool;
let repository: typeof import("./data-cutover.repository");

describePg("cutover native target lookup SQL", () => {
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url) throw new Error("Native lookup URL must exactly match DATABASE_URL");
    const parsed = new URL(url);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.port !== "55471" || parsed.pathname !== "/cerp_cutover_native_1710") {
      throw new Error("Refusing non-native isolated fixture");
    }
    db = new Pool({ connectionString: url });
    const identity = await db.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== "cerp_cutover_native_1710") throw new Error("Unexpected database identity");
    repository = await import("./data-cutover.repository");
    appPool = (await import("../../../config/database")).default;
  });

  afterAll(async () => { await appPool?.end(); await db?.end(); });

  it("uses native order, line and delivery-affair fields without interpolating a search", async () => {
    for (const entity of ["NATIVE_ORDER", "NATIVE_ORDER_LINE", "DELIVERY_AFFAIR"] as const) {
      await expect(repository.repoCutoverLookup(entity, "fixture")).resolves.toMatchObject({ items: expect.any(Array) });
      await expect(repository.repoCutoverLookup(entity, "' OR 1=1 --")).resolves.toEqual({ items: [] });
    }
  });
});
