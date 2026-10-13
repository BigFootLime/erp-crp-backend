import { describe, expect, it, vi } from "vitest";
import { readOfDocumentInternalDue } from "./of-document-deadline.repository";
import type { DbQueryer } from "./of-versioning.repository";

describe("OF document original internal deadline", () => {
  function fixture(lineDates: Array<string | null>, targets: Array<{of_id: string; target_date: string}>) {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("AS installed") ? [{installed: true}]
      : sql.includes("WITH requested") ? targets : lineDates.map(internal_due => ({internal_due})) }));
    return { query: query as unknown as DbQueryer["query"] };
  }
  it("keeps a past contract target instead of replacing it with a forecast date", async () => {
    const tx = fixture([null], [{of_id: "95", target_date: "2026-09-30"}]);
    expect(await readOfDocumentInternalDue(tx, [95])).toBe("2026-09-30");
  });
  it("uses the earliest real internal target across a grouping", async () => {
    expect(await readOfDocumentInternalDue(fixture(["2026-10-20", "2026-10-15"], [{of_id: "96", target_date: "2026-10-31"}]), [95,96])).toBe("2026-10-15");
  });
  it("does not invent a date for a dossier with no target", async () => {
    expect(await readOfDocumentInternalDue(fixture([null], []), [95])).toBeNull();
  });
});
