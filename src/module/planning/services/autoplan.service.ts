export type AutoplanResource =
  | { resource_type: "POSTE"; poste_id: string; machine_id?: never }
  | { resource_type: "MACHINE"; machine_id: string; poste_id?: never };

export type AutoplanBlockingEvent = {
  start_ts: string; // ISO string
  end_ts: string; // ISO string
};

export type AutoplanTask = {
  phase: number;
  designation: string;
  duration_minutes: number;
};

export type AutoplanPlannedTask = AutoplanTask &
  AutoplanResource & {
    start_ts: string;
    end_ts: string;
  };

function clampPositiveInt(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  return v > 0 ? v : fallback;
}

function ceilToStepMinutes(tsMs: number, stepMinutes: number): number {
  const stepMs = stepMinutes * 60_000;
  if (stepMs <= 0) return tsMs;
  return Math.ceil(tsMs / stepMs) * stepMs;
}

function parseTs(value: string, label: string): number {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new Error(`Invalid ${label}: ${value}`);
  return t;
}

function normalizeBlockingEvents(events: AutoplanBlockingEvent[]): Array<{ startMs: number; endMs: number }> {
  const out: Array<{ startMs: number; endMs: number }> = [];
  for (const e of events) {
    const startMs = parseTs(e.start_ts, "start_ts");
    const endMs = parseTs(e.end_ts, "end_ts");
    if (startMs >= endMs) continue;
    out.push({ startMs, endMs });
  }
  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return out;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  // [start, end) overlap
  return aStart < bEnd && bStart < aEnd;
}

function findNextNonOverlappingStart(params: {
  startMs: number;
  durationMs: number;
  blocks: Array<{ startMs: number; endMs: number }>;
}): number {
  let start = params.startMs;
  let end = start + params.durationMs;

  for (const b of params.blocks) {
    if (!overlaps(start, end, b.startMs, b.endMs)) continue;
    start = b.endMs;
    end = start + params.durationMs;
  }
  return start;
}

export function autoplanGreedySequential(params: {
  start_ts: string;
  resource: AutoplanResource;
  tasks: AutoplanTask[];
  blocking_events: AutoplanBlockingEvent[];
  step_minutes?: number;
}): AutoplanPlannedTask[] {
  const stepMinutes = clampPositiveInt(params.step_minutes ?? 15, 15);
  const baseStartMsRaw = parseTs(params.start_ts, "start_ts");
  const baseStartMs = ceilToStepMinutes(baseStartMsRaw, stepMinutes);
  const blocks = normalizeBlockingEvents(params.blocking_events);

  let cursor = baseStartMs;
  const planned: AutoplanPlannedTask[] = [];

  for (const t of params.tasks) {
    const durationMinutes = clampPositiveInt(t.duration_minutes, 1);
    const durationMs = durationMinutes * 60_000;
    const startMs = findNextNonOverlappingStart({ startMs: cursor, durationMs, blocks });
    const roundedStartMs = ceilToStepMinutes(startMs, stepMinutes);
    const endMs = roundedStartMs + durationMs;

    planned.push({
      ...t,
      ...params.resource,
      start_ts: new Date(roundedStartMs).toISOString(),
      end_ts: new Date(endMs).toISOString(),
    });

    cursor = endMs;
    blocks.push({ startMs: roundedStartMs, endMs });
    blocks.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  }

  return planned;
}
