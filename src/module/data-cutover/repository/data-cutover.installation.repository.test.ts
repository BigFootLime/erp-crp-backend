import { describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("../../../config/database", () => ({ default: { query } }));

import { repoIsCutoverApplicationInstalled } from "./data-cutover.repository";

describe("cutover application installation gate", () => {
  it("fails closed until both WIP opening migrations are present", async () => {
    query.mockResolvedValueOnce({ rows: [{ installed: false }] });
    await expect(repoIsCutoverApplicationInstalled()).resolves.toBe(false);
    const sql = String(query.mock.calls[0]?.[0]);
    for (const table of [
      "data_cutover_wip_resumptions",
      "data_cutover_wip_operation_checkpoints",
      "data_cutover_wip_material_checkpoints",
      "data_cutover_wip_material_checkpoint_lines",
      "data_cutover_wip_material_opening_bindings",
    ]) expect(sql).toContain(table);
  });
});
