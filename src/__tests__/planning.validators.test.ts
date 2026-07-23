import { describe, expect, it } from "vitest";

import {
  createPlanningEventCommentSchema,
  createPlanningEventSchema,
  isValidPlanningDateTime,
  listPlanningEventsQuerySchema,
} from "../module/planning/validators/planning.validators";

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
