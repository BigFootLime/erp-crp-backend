import type { Interval } from "../types/planning-central.types";
export type WeeklyShift = { weekday: number; startMinute: number; endMinute: number };
export type CalendarDefinition = { timezone: string; shifts: WeeklyShift[]; closures: Interval[]; closedDates: string[] };
const MINUTE = 60000;
function civil(utc: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(utc));
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return { date: get("year") + "-" + get("month") + "-" + get("day"), minute: Number(get("hour")) * 60 + Number(get("minute")) };
}
/** Minute-level expansion uses UTC instants then tests local civil time: both folds of DST exist, skipped minutes do not. */
export function expandCalendar(calendar: CalendarDefinition, from: string, to: string): Interval[] {
  const start = Math.ceil(Date.parse(from) / MINUTE) * MINUTE, end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 367 * 86400000) throw new Error("INVALID_CALENDAR_WINDOW");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: calendar.timezone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const closedDates = new Set(calendar.closedDates);
  const closures = calendar.closures.map(c => [Date.parse(c.start), Date.parse(c.end)]);
  const result: Interval[] = [];
  let open: number | null = null;
  for (let t = start; t < end; t += MINUTE) {
    const parts = formatter.formatToParts(new Date(t));
    const get = (k: string) => parts.find(p => p.type === k)!.value;
    const date = get("year") + "-" + get("month") + "-" + get("day");
    const minute = Number(get("hour")) * 60 + Number(get("minute"));
    const weekday = new Date(date + "T12:00:00Z").getUTCDay();
    const on = !closedDates.has(date) && calendar.shifts.some(s => s.weekday === weekday &&
      minute >= s.startMinute && minute < s.endMinute) &&
      !closures.some(([a, b]) => t < b && t + MINUTE > a);
    if (on && open === null) open = t;
    if (!on && open !== null) { result.push({ start: new Date(open).toISOString(), end: new Date(t).toISOString() }); open = null; }
  }
  if (open !== null) result.push({ start: new Date(open).toISOString(), end: new Date(end).toISOString() });
  return result;
}
export function addWorkingDays(instant: string, days: number, timezone: string, closedDates: string[] = []): string {
  if (!Number.isInteger(days) || days < 0 || days > 366) throw new Error("INVALID_WORKING_DAYS");
  let t = Date.parse(instant), left = days;
  if (!Number.isFinite(t)) throw new Error("INVALID_DATE");
  const initial = civil(t, timezone);
  for (let guard = 0; left && guard < 1100; guard++) {
    t += 86400000;
    const c = civil(t, timezone);
    // Keep the same wall-clock hour across daylight saving transitions.
    t += (initial.minute - c.minute) * MINUTE;
    const day = civil(t, timezone).date;
    const weekday = new Date(day + "T12:00:00Z").getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !closedDates.includes(day)) left--;
  }
  if (left) throw new Error("NO_WORKING_DAY");
  return new Date(t).toISOString();
}

