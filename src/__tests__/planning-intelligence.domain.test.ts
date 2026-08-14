import { describe, expect, it } from "vitest";

import {
  buildPlanningExecutionIntelligence,
  defaultPlanningPreferences,
  type PlanningCapacityRawRow,
  type PlanningIntelligenceEventRow,
  type PlanningIntelligencePointageRow,
  type PlanningIntelligenceSnapshot,
} from "../module/planning/domain/planning-intelligence";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const MACHINE_1 = "11111111-1111-4111-8111-111111111111";
const MACHINE_2 = "22222222-2222-4222-8222-222222222222";

function event(overrides: Partial<PlanningIntelligenceEventRow> = {}): PlanningIntelligenceEventRow {
  return {
    event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    of_id: 21,
    of_numero: "OF-SOL21-001",
    operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    phase: 10,
    designation: "Usinage",
    event_status: "PLANNED",
    operation_status: "DONE",
    start_ts: "2026-08-14T08:00:00.000Z",
    end_ts: "2026-08-14T10:00:00.000Z",
    updated_at: "2026-08-14T10:01:00.000Z",
    operation_ended_at: "2026-08-14T09:55:00.000Z",
    planned_hours: 2,
    machine_id: MACHINE_1,
    machine_code: "M-01",
    machine_name: "Tour 1",
    machine_available: true,
    allow_overlap: false,
    ...overrides,
  };
}

function pointage(overrides: Partial<PlanningIntelligencePointageRow> = {}): PlanningIntelligencePointageRow {
  return {
    pointage_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    of_id: 21,
    operation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    machine_id: MACHINE_1,
    machine_code: "M-01",
    activity_code: "PRODUCTION",
    activity_label: "Production",
    activity_is_productive: true,
    is_running: false,
    start_ts: "2026-08-14T08:30:00.000Z",
    end_ts: "2026-08-14T09:30:00.000Z",
    duration_minutes: 60,
    comment: null,
    updated_at: "2026-08-14T09:30:00.000Z",
    ...overrides,
  };
}

function capacity(overrides: Partial<PlanningCapacityRawRow> = {}): PlanningCapacityRawRow {
  return {
    machine_id: MACHINE_1,
    machine_code: "M-01",
    machine_name: "Tour 1",
    week_start: "2026-08-10",
    available_minutes: 1_000,
    calendar_count: 1,
    calendar_freshness_at: "2026-08-14T07:00:00.000Z",
    planned_event: null,
    planned_minutes: 0,
    actual_minutes: 0,
    ...overrides,
  };
}

function build(snapshot: PlanningIntelligenceSnapshot) {
  return buildPlanningExecutionIntelligence({
    snapshot,
    from: "2026-08-10T00:00:00.000Z",
    to: "2026-08-17T00:00:00.000Z",
    timezone: "Europe/Paris",
    agedWipDays: 7,
    capabilities: {
      read_capacity: true,
      manage_schedule: true,
      manage_preferences: true,
      supervise_execution: true,
    },
    now: NOW,
  });
}

describe("SOL-21 planning and execution intelligence", () => {
  it("calculates traceable KPIs, bottlenecks, stop causes and actionable conflicts", () => {
    const first = event();
    const second = event({
      event_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      of_id: 22,
      of_numero: "OF-SOL21-002",
      operation_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      phase: 20,
      start_ts: "2026-08-14T09:30:00.000Z",
      end_ts: "2026-08-14T11:00:00.000Z",
      operation_status: "RUNNING",
      operation_ended_at: null,
      planned_hours: null,
      machine_available: false,
      allow_overlap: true,
    });
    const snapshot: PlanningIntelligenceSnapshot = {
      events: [first, second],
      pointages: [
        pointage(),
        pointage({
          pointage_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          operation_id: second.operation_id,
          machine_id: MACHINE_2,
          machine_code: "M-02",
          activity_code: "BREAKDOWN",
          activity_label: "Panne",
          activity_is_productive: false,
          duration_minutes: 30,
        }),
        pointage({
          pointage_id: "99999999-9999-4999-8999-999999999999",
          operation_id: second.operation_id,
          is_running: true,
          start_ts: "2026-08-13T23:00:00.000Z",
          end_ts: NOW.toISOString(),
          duration_minutes: 780,
        }),
      ],
      quantities: [{
        unit: "u",
        qty_good: 90,
        qty_scrap: 10,
        qty_rework: 2,
        freshness_at: "2026-08-14T11:00:00.000Z",
      }],
      wip: [{
        of_id: 22,
        of_numero: "OF-SOL21-002",
        operation_id: second.operation_id,
        machine_id: MACHINE_1,
        started_at: "2026-08-01T08:00:00.000Z",
        due_date: "2026-08-13",
      }],
      capacity: [
        capacity(),
        capacity({ planned_event: first, planned_minutes: 900 }),
        capacity({ planned_event: second, planned_minutes: 400 }),
        capacity({ actual_minutes: 870 }),
      ],
    };

    const result = build(snapshot);

    expect(result.kpis.schedule_adherence).toMatchObject({ value: 50, numerator: 1, denominator: 2, reliability: "VERIFIED" });
    expect(result.kpis.throughput.value).toBe(1);
    expect(result.kpis.wip.value).toBe(1);
    expect(result.kpis.aged_wip.value).toBe(1);
    expect(result.kpis.scrap_rate).toMatchObject({ value: 10, numerator: 10, denominator: 100, reliability: "VERIFIED" });
    expect(result.kpis.planned_time).toMatchObject({ value: 2, denominator: 2, reliability: "PARTIAL" });
    expect(result.kpis.actual_time).toMatchObject({ value: 14.5, numerator: 870, reliability: "VERIFIED" });
    expect(result.capacity[0]).toMatchObject({ planned_minutes: 1300, actual_minutes: 870, utilization_pct: 130, state: "BOTTLENECK" });
    expect(result.capacity[0]?.drilldown).toHaveLength(2);
    expect(result.stop_causes).toEqual([{ code: "BREAKDOWN", label: "Panne", duration_minutes: 30, occurrences: 1, reason_missing_count: 0, source: "production_pointages" }]);
    expect(new Set(result.conflicts.map((item) => item.code))).toEqual(new Set([
      "SCHEDULE_OVERLAP",
      "RESOURCE_UNAVAILABLE",
      "ACTUAL_RESOURCE_MISMATCH",
      "LONG_RUNNING_EXECUTION",
      "MISSING_PLANNED_TIME",
    ]));
    expect(result.action_queue[0]?.priority).toBe("P0");
    expect(result.metadata.sources).toContain("public.production_pointages");
    expect(result.metadata.freshness_at).toBe("2026-08-14T11:00:00.000Z");
  });

  it("never turns a missing unit or missing calendar into a trustworthy zero", () => {
    const result = build({
      events: [],
      pointages: [],
      quantities: [{ unit: "UNSPECIFIED", qty_good: 10, qty_scrap: 1, qty_rework: 0, freshness_at: null }],
      wip: [{ of_id: 1, of_numero: "OF-1", operation_id: null, machine_id: MACHINE_1, started_at: null, due_date: null }],
      capacity: [capacity({ available_minutes: null, calendar_count: 0 })],
    });

    expect(result.kpis.scrap_rate).toMatchObject({ value: null, reliability: "PARTIAL" });
    expect(result.kpis.scrap_rate.missing.join(" ")).toMatch(/unité/i);
    expect(result.capacity[0]).toMatchObject({ available_minutes: null, utilization_pct: null, state: "UNAVAILABLE", reliability: "UNAVAILABLE" });
    expect(result.kpis.aged_wip).toMatchObject({ value: 0, reliability: "PARTIAL" });
  });

  it("flags planned work on a zero-capacity week as a bottleneck", () => {
    const planned = event();
    const result = build({
      events: [planned],
      pointages: [],
      quantities: [],
      wip: [],
      capacity: [capacity({ available_minutes: 0 }), capacity({ available_minutes: 0, planned_event: planned, planned_minutes: 60 })],
    });
    expect(result.capacity[0]).toMatchObject({ available_minutes: 0, planned_minutes: 60, utilization_pct: null, state: "BOTTLENECK" });
  });

  it("provides deterministic, non-business defaults for personal preferences", () => {
    expect(defaultPlanningPreferences()).toEqual({
      timezone: "Europe/Paris",
      horizon_weeks: 6,
      view_mode: "WEEK",
      show_weekends: false,
      machine_ids: [],
      status_colors: {},
      client_color_overrides: {},
      updated_at: null,
    });
  });
});
