import { expect, it, vi } from "vitest";
import { readWorkshopPlanSources } from "./workshop-plan-sources.repository";
import type { DbQueryer } from "./of-versioning.repository";

it("binds every pinned reference and preserves its original link role without selecting the latest PT plan", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ version_id: "pinned" }] });
  const result = await readWorkshopPlanSources({ query } as DbQueryer, "version-of-this-of", [
    { id: "doc", version_id: "pinned", role: "PLAN_CLIENT", source_role: "PLAN", sha256: "saved" },
  ]);
  expect(result).toEqual([{ version_id: "pinned" }]);
  expect(query.mock.calls[0][1][0]).toBe("version-of-this-of");
  expect(JSON.parse(query.mock.calls[0][1][1])[0]).toMatchObject({ id: "doc", version_id: "pinned", sha256: "saved", link_role: "PLAN", position: 0 });
  const sql = query.mock.calls[0][0];
  for (const guard of ["version.document_id=document.id", "blob.sha256=frozen.sha256", "scan.scan_status='clean'",
    "scan.quarantine_status='released'", "link.entity_id=$1", "link.link_role=frozen.link_role"]) expect(sql).toContain(guard);
  expect(sql).not.toMatch(/current_version_id|ORDER BY.*created_at/i);
});

it("does not query another definition when the frozen dossier contains no plan", async () => {
  const query = vi.fn();
  expect(await readWorkshopPlanSources({ query } as DbQueryer, "version", [])).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});
