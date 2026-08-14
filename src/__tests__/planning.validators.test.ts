import { describe, expect, it } from "vitest";

import {
  createPlanningEventCommentSchema,
  createPlanningEventSchema,
  isValidPlanningDateTime,
  listPlanningEventsQuerySchema,
} from "../module/planning/validators/planning.validators";
import {
  planningIntelligenceQuerySchema,
  planningPreferencesBodySchema,
} from "../module/planning/validators/planning-intelligence.validators";

describe("planning datetime validation", () => {
  it("accepts more than 100 offset-qualified ISO-8601 combinations", () => {
    const dates = ["2026-01-15", "2026-03-29", "2026-07-23", "2026-10-25", "2026-12-31"];
    const times = ["00:00:00", "08:00:00", "08:00:00.123", "16:45:59", "23:59:59.999999"];
    const offsets = ["Z", "+00", "+0000", "+00:00", "+02:00", "-05:00"];
    const separators = ["T", " "];

    let checked = 0;
    for (const date of dates) {
      for (const time of times) {
        for (const offset of offsets) {
          for (const separator of separators) {
            expect(isValidPlanningDateTime(`${date}${separator}${time}${offset}`)).toBe(true);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(300);
  });

  it.each([
    "2026",
    "2026-07-23",
    "2026-07-23T08:00",
    "2026-03-29T02:30:00",
    "2026-07-23T08:00:00+2:00",
    "2026-07-23T08:00:00 Europe/Paris",
    "garbage",
    "",
  ])("rejects ambiguous or malformed datetime %s", (value) => {
    expect(isValidPlanningDateTime(value)).toBe(false);
  });
});

describe("planning request schemas", () => {
  const baseEvent = {
    kind: "CUSTOM" as const,
    machine_id: "11111111-1111-4111-8111-111111111111",
    title: "Controle",
    start_ts: "2026-07-23T08:00:00+02:00",
    end_ts: "2026-07-23T09:00:00+02:00",
  };

  it("rejects unknown event fields", () => {
    expect(() => createPlanningEventSchema.parse({ body: { ...baseEvent, visual_x: 42 } })).toThrow();
  });

  it("rejects unknown comment fields", () => {
    expect(() => createPlanningEventCommentSchema.parse({ body: { body: "Ok", role: "admin" } })).toThrow();
  });

  it("provides bounded pagination defaults", () => {
    const out = listPlanningEventsQuerySchema.parse({
      from: "2026-07-23T00:00:00+02:00",
      to: "2026-07-24T00:00:00+02:00",
    });
    expect(out.limit).toBe(2000);
    expect(out.offset).toBe(0);
  });

  it("caps planning list pages", () => {
    expect(() =>
      listPlanningEventsQuerySchema.parse({
        from: "2026-07-23T00:00:00+02:00",
        to: "2026-07-24T00:00:00+02:00",
        limit: 5001,
      })
    ).toThrow();
  });
});

describe("SOL-21 intelligence and preference schemas", () => {
  it("accepts a timezone-qualified period up to 13 weeks", () => {
    const parsed = planningIntelligenceQuerySchema.parse({
      from: "2026-08-01T00:00:00+02:00",
      to: "2026-10-30T00:00:00+01:00",
      timezone: "Europe/Paris",
      aged_wip_days: "14",
    });
    expect(parsed.aged_wip_days).toBe(14);
  });

  it("rejects reversed, oversized and unknown-timezone periods", () => {
    expect(() => planningIntelligenceQuerySchema.parse({
      from: "2026-08-02T00:00:00Z",
      to: "2026-08-01T00:00:00Z",
    })).toThrow();
    expect(() => planningIntelligenceQuerySchema.parse({
      from: "2026-01-01T00:00:00Z",
      to: "2026-12-31T00:00:00Z",
    })).toThrow();
    expect(() => planningIntelligenceQuerySchema.parse({
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-02T00:00:00Z",
      timezone: "Mars/Olympus",
    })).toThrow();
  });

  it("normalizes colors and rejects invalid preferences or unknown fields", () => {
    const body = {
      timezone: "Europe/Paris",
      horizon_weeks: 6,
      view_mode: "WEEK" as const,
      show_weekends: false,
      machine_ids: [],
      status_colors: { RUNNING: "#aabbcc" },
      client_color_overrides: {},
    };
    expect(planningPreferencesBodySchema.parse({ body }).body.status_colors.RUNNING).toBe("#AABBCC");
    expect(() => planningPreferencesBodySchema.parse({ body: { ...body, timezone: "Not/AZone" } })).toThrow();
    expect(() => planningPreferencesBodySchema.parse({ body: { ...body, injected_role: "admin" } })).toThrow();
  });
});
