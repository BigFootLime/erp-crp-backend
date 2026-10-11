import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("../../../config/database", () => ({ default: {} }));
import { taskFromRow } from "./planning-central.repository";

const row = { id: "op:1", operation_id: "1", source: "OPERATION", reference: "PT-A", label: "Cut",
  quantity: 4, phase: 10, setup_minutes: 0, unit_minutes: 2, status: "READY", readiness: "VALIDATED",
  created_at: "2026-10-11T07:00:00.000Z", updated_at: "2026-10-11T07:00:00.000Z" };
describe("central task canonical phase", () => {
  it.each([10, "20"])("projects the database phase %s without parsing the label", phase => {
    const input = { ...row, phase, label: "A label containing phase 999" };
    const task = taskFromRow(input);
    expect(task.phase).toBe(Number(phase));
    expect(task.label).toBe(input.label);
    expect(task.version).toBe(createHash("sha256").update(JSON.stringify(input)).digest("hex"));
    expect(input.phase).toBe(phase);
  });
  it.each(["DRAFT", "PROGRAMMING"])("does not invent an operation phase for %s", source => {
    expect(taskFromRow({ ...row, source, phase: 0 }).phase).toBeNull();
  });
});
