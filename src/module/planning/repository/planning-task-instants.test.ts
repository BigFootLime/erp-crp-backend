import { describe, expect, it, vi } from "vitest";
vi.mock("../../../config/database", () => ({ default: {} }));
import { taskFromRow } from "./planning-central.repository";
import { schedule } from "../domain/central-scheduler";
import type { Resource } from "../types/planning-central.types";

const start = "2026-10-12T05:00:00.000Z";
const boundary = "2026-10-12T05:09:03.600Z";
const row = { id: "op:previous", operation_id: "previous", source: "OPERATION", reference: "PLAT",
  resource_id: "poste:cut", quantity: 4, good: 0, phase: 10, setup_minutes: 0, unit_minutes: 2,
  status: "READY", readiness: "VALIDATED", created_at: new Date(start), updated_at: new Date(boundary) };

describe("central PostgreSQL timestamp precision", () => {
  it.each([new Date(boundary), boundary, "2026-10-12T07:09:03.600+02:00"])(
    "keeps the exact occupied interval for %s", end => {
      const task = taskFromRow({ ...row, committed_start: new Date(start), committed_end: end });
      expect(task.committed).toEqual({ start, end: boundary });
    });
  it("keeps fractional precision in forecasts, actual execution and readiness", () => {
    const task = taskFromRow({ ...row, forecast_start: new Date(start), forecast_end: new Date(boundary),
      actual_start: new Date(start), actual_end: new Date(boundary), earliest_start: new Date(boundary) });
    expect(task.forecast).toEqual({ start, end: boundary });
    expect(task.actual).toEqual({ start, end: boundary });
    expect(task.earliestStart).toBe(boundary);
  });
  it("places the next cut exactly after the persisted fractional end", () => {
    const previous = taskFromRow({ ...row, committed_start: new Date(start), committed_end: new Date(boundary) });
    const next = taskFromRow({ ...row, id: "op:next", operation_id: "next", reference: "AXE" });
    const resource: Resource = { id: "poste:cut", kind: "POSTE", label: "Cut", timezone: "Europe/Paris",
      version: "1", availability: [{ start, end: "2026-10-12T07:00:00.000Z" }] };
    const result = schedule({ tasks: [previous, next], resources: [resource], dependencies: [], from: start,
      requested: [{ taskId: next.id, earliestStart: "2026-10-12T05:09:00.000Z" }] });
    expect(result.feasible).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].after.start).toBe(boundary);
    expect(Date.parse(result.changes[0].after.start)).toBeGreaterThanOrEqual(new Date(boundary).getTime());
    expect(previous.committed?.end).toBe(boundary);
  });
});
