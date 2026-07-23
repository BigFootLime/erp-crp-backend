import { describe, expect, it } from "vitest";

import {
  autoplanGreedySequential,
  overlaps,
  type AutoplanBlockingEvent,
} from "../module/planning/services/autoplan.service";

const MINUTE = 60_000;

describe("planning [start, end) convention", () => {
  it("matches the half-open oracle for 225 ordered interval pairs", () => {
    const boundaries = [0, 15, 30, 45, 60, 75];
    const intervals: Array<[number, number]> = [];
    for (let i = 0; i < boundaries.length; i += 1) {
      for (let j = i + 1; j < boundaries.length; j += 1) {
        intervals.push([boundaries[i] * MINUTE, boundaries[j] * MINUTE]);
      }
    }

    let checked = 0;
    for (const [aStart, aEnd] of intervals) {
      for (const [bStart, bEnd] of intervals) {
        const expected = aStart < bEnd && bStart < aEnd;
        expect(overlaps(aStart, aEnd, bStart, bEnd)).toBe(expected);
        if (aEnd === bStart || bEnd === aStart) {
          expect(overlaps(aStart, aEnd, bStart, bEnd)).toBe(false);
        }
        checked += 1;
      }
    }
    expect(checked).toBe(225);
  });
});

describe("autoplan greedy sequencing", () => {
  it("preserves scheduling invariants over 192 combinations", () => {
    const taskCounts = [1, 2, 3, 5];
    const durations = [1, 15, 45, 90];
    const steps = [1, 15, 30];
    const baseMs = Date.parse("2026-03-29T00:30:00Z");
    const blockSets: AutoplanBlockingEvent[][] = [
      [],
      [{ start_ts: new Date(baseMs + 30 * MINUTE).toISOString(), end_ts: new Date(baseMs + 60 * MINUTE).toISOString() }],
      [
        { start_ts: new Date(baseMs + 15 * MINUTE).toISOString(), end_ts: new Date(baseMs + 30 * MINUTE).toISOString() },
        { start_ts: new Date(baseMs + 30 * MINUTE).toISOString(), end_ts: new Date(baseMs + 45 * MINUTE).toISOString() },
      ],
      [{ start_ts: new Date(baseMs).toISOString(), end_ts: new Date(baseMs + 15 * MINUTE).toISOString() }],
    ];

    let checked = 0;
    for (const taskCount of taskCounts) {
      for (const duration of durations) {
        for (const step of steps) {
          for (const blocking_events of blockSets) {
            const planned = autoplanGreedySequential({
              start_ts: new Date(baseMs).toISOString(),
              resource: { resource_type: "MACHINE", machine_id: "11111111-1111-4111-8111-111111111111" },
              tasks: Array.from({ length: taskCount }, (_, phase) => ({
                phase: phase + 1,
                designation: `Operation ${phase + 1}`,
                duration_minutes: duration,
              })),
              blocking_events,
              step_minutes: step,
            });

            expect(planned).toHaveLength(taskCount);
            for (let index = 0; index < planned.length; index += 1) {
              const item = planned[index];
              const start = Date.parse(item.start_ts);
              const end = Date.parse(item.end_ts);
              expect(end - start).toBe(duration * MINUTE);
              expect(start % (step * MINUTE)).toBe(0);
              if (index > 0) expect(start).toBeGreaterThanOrEqual(Date.parse(planned[index - 1].end_ts));
              for (const block of blocking_events) {
                expect(overlaps(start, end, Date.parse(block.start_ts), Date.parse(block.end_ts))).toBe(false);
              }
            }
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(192);
  });

  it.each([
    "2026-03-29T00:45:00Z",
    "2026-03-29T01:00:00Z",
    "2026-10-25T00:45:00Z",
    "2026-10-25T01:00:00Z",
  ])("keeps real elapsed durations across Europe/Paris DST boundary %s", (start_ts) => {
    const planned = autoplanGreedySequential({
      start_ts,
      resource: { resource_type: "POSTE", poste_id: "22222222-2222-4222-8222-222222222222" },
      tasks: [{ phase: 10, designation: "DST", duration_minutes: 45 }],
      blocking_events: [],
      step_minutes: 15,
    });
    expect(Date.parse(planned[0].end_ts) - Date.parse(planned[0].start_ts)).toBe(45 * MINUTE);
  });
});
