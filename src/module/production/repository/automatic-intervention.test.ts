import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import { releasePreviousIntervention } from "./automatic-intervention.repository";
function db(previous: unknown) {
  const query = vi.fn(async (sql: string) => ({
    rows:
      sql.includes("status='RUNNING'") && sql.includes("SELECT id")
        ? previous
          ? [previous]
          : []
        : sql.includes("RETURNING id")
          ? [{ id: "automatic-next" }]
          : [],
    rowCount: 1,
  }));
  return { query, tx: { query } as unknown as PoolClient };
}
describe("one personal intervention across machines", () => {
  it("requires explicit confirmation before ending another personal intervention", async () => {
    const { query, tx } = db({
      id: "previous",
      machine_id: "machine-a",
      activity_code: "PRODUCTION",
    });
    await expect(
      releasePreviousIntervention(tx, 7, null),
    ).rejects.toMatchObject({ code: "PERSONAL_INTERVENTION_ACTIVE" });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
      false,
    );
  });
  it("releases personal time and starts the automatic segment through the same transaction", async () => {
    const { query, tx } = db({
      id: "previous",
      machine_id: "machine-a",
      activity_code: "PRODUCTION",
      operation_id: "op",
    });
    await releasePreviousIntervention(tx, 7, null, "previous");
    expect(
      query.mock.calls.filter(([sql]) =>
        sql.includes("INSERT INTO public.production_pointages"),
      ),
    ).toHaveLength(1);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes("'MACHINE','AUTO_MACHINE'"),
      ),
    ).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });
  it("never leaves a setup or a control running automatically", async () => {
    const { tx, query } = db({
      id: "previous",
      machine_id: "machine-a",
      activity_code: "SETUP",
    });
    await expect(
      releasePreviousIntervention(tx, 7, null, "previous"),
    ).rejects.toMatchObject({ code: "INTERVENTION_NOT_AUTOMATIC" });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
      false,
    );
  });
  it("refuses stale consent after the previous intervention changed", async () => {
    const { tx } = db(null);
    await expect(
      releasePreviousIntervention(tx, 7, null, "previous"),
    ).rejects.toMatchObject({ code: "INTERVENTION_CHANGED" });
  });
});
