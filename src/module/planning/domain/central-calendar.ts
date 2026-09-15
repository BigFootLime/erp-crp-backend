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
const expansionCache = new Map<string, Interval[]>();
/** Expand constant-offset UTC hours as intervals. Only transition hours need minute sampling. */
export function expandCalendar(calendar: CalendarDefinition, from: string, to: string): Interval[] {
  const start = Math.ceil(Date.parse(from) / MINUTE) * MINUTE, end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 367 * 86400000) throw new Error("INVALID_CALENDAR_WINDOW");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: calendar.timezone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const closedDates = new Set(calendar.closedDates);
  const key = JSON.stringify([calendar.timezone,calendar.shifts,calendar.closedDates,start,end]);
  let opening = expansionCache.get(key);
  const local = (t: number) => {
    const parts = formatter.formatToParts(new Date(t));
    const get = (k: string) => parts.find(p => p.type === k)!.value;
    const date = get("year") + "-" + get("month") + "-" + get("day");
    const minute = Number(get("hour")) * 60 + Number(get("minute"));
    const weekday = new Date(date + "T12:00:00Z").getUTCDay();
    return {date,minute,weekday};
  };
  if (!opening) {
    const windows: Array<{start:number;end:number}> = [];
    for (let t = start; t < end;) {
      const next = Math.min(end,(Math.floor(t/3600000)+1)*3600000);
      const last = Math.floor((next-1)/MINUTE)*MINUTE;
      const a = local(t), b = local(last);
      if (a.date === b.date && b.minute-a.minute === (last-t)/MINUTE) {
        if (!closedDates.has(a.date)) for (const shift of calendar.shifts) if (shift.weekday === a.weekday) {
          const left = Math.max(t,t+(shift.startMinute-a.minute)*MINUTE), right = Math.min(next,t+(shift.endMinute-a.minute)*MINUTE);
          if (right > left) windows.push({start:left,end:right});
        }
      } else {
        for (let minute = t; minute < next; minute += MINUTE) {
          const c = local(minute);
          if (!closedDates.has(c.date) && calendar.shifts.some(s => s.weekday === c.weekday && c.minute >= s.startMinute && c.minute < s.endMinute))
            windows.push({start:minute,end:Math.min(next,minute+MINUTE)});
        }
      }
      t = next;
    }
    const merged: typeof windows = [];
    for (const w of windows.sort((a,b)=>a.start-b.start)) {
      const last = merged[merged.length-1];
      if (last && w.start <= last.end) last.end = Math.max(last.end,w.end); else merged.push({...w});
    }
    opening = merged.map(w=>({start:new Date(w.start).toISOString(),end:new Date(w.end).toISOString()}));
    // Values depend only on the complete civil calendar, not on mutable resource state.
    if (expansionCache.size >= 64) expansionCache.delete(expansionCache.keys().next().value!);
    expansionCache.set(key,opening);
  }
  let windows = opening.map(w=>({start:Date.parse(w.start),end:Date.parse(w.end)}));
  // Preserve the original rule: a closure touching any part of a minute closes that minute.
  for (const c of calendar.closures) {
    const a = Math.floor(Date.parse(c.start)/MINUTE)*MINUTE, b = Math.ceil(Date.parse(c.end)/MINUTE)*MINUTE;
    windows = windows.flatMap(w=> b<=w.start || a>=w.end ? [w] :
      [{start:w.start,end:Math.min(w.end,a)},{start:Math.max(w.start,b),end:w.end}].filter(w=>w.end>w.start));
  }
  return windows.map(w=>({start:new Date(w.start).toISOString(),end:new Date(w.end).toISOString()}));
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

