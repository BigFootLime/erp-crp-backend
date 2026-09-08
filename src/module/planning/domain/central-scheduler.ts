import type { CentralTask, Dependency, Interval, Resource, ScheduleResult } from "../types/planning-central.types";
const ms = (v: string) => Date.parse(v);
const iso = (v: number) => new Date(v).toISOString();
function intersects(a: Interval, b: Interval) { return ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end); }
/** Find capacity across shared open intervals, excluding all reservations. Returns elapsed span (including closed shifts). */
export function capacitySlot(resources: Resource[], occupied: Map<string, Interval[]>, earliest: number, minutes: number): Interval | null {
  if (!resources.length || minutes <= 0 || !Number.isFinite(minutes) || !Number.isFinite(earliest)) return null;
  let windows = resources[0].availability.map(i => ({ start: ms(i.start), end: ms(i.end) }));
  for (const r of resources.slice(1)) {
    windows = windows.flatMap(a => r.availability.map(b => ({ start: Math.max(a.start, ms(b.start)), end: Math.min(a.end, ms(b.end)) })))
      .filter(a => a.end > a.start);
  }
  const blocked = resources.flatMap(r => occupied.get(r.capacityId ?? r.id) ?? []).map(i => ({ start: ms(i.start), end: ms(i.end) }));
  windows = windows.sort((a, b) => a.start - b.start).map(w => ({ start: Math.max(w.start, earliest), end: w.end })).filter(w => w.end > w.start);
  for (const b of blocked) windows = windows.flatMap(w => b.end <= w.start || b.start >= w.end ? [w] :
    [{ start: w.start, end: Math.min(w.end, b.start) }, { start: Math.max(w.start, b.end), end: w.end }].filter(w => w.end > w.start));
  windows.sort((a, b) => a.start - b.start);
  // A resource is reserved for the span of an operation; do not bridge another operation.
  for (let i = 0; i < windows.length; i++) {
    let remaining = minutes * 60000, end = windows[i].start;
    for (let j = i; j < windows.length; j++) {
      if (j > i && blocked.some(b => b.start < windows[j].start && b.end > end)) break;
      const use = Math.min(remaining, windows[j].end - windows[j].start);
      remaining -= use; end = windows[j].start + use;
      if (remaining <= 0) return { start: iso(windows[i].start), end: iso(end) };
    }
  }
  return null;
}
export function schedule(input: {
  tasks: CentralTask[]; resources: Resource[]; dependencies: Dependency[]; from: string;
  requested: Array<{ taskId: string; earliestStart: string; resourceIds?: string[]; autoAssign?: boolean }>;
  signal?: AbortSignal;
}): ScheduleResult {
  const result: ScheduleResult = { changes: [], forecasts: {}, conflicts: [], feasible: false, affected: [] };
  const byId = new Map(input.tasks.map(t => [t.id, t]));
  const resourceMap = new Map(input.resources.map(r => [r.id, r]));
  const requests = new Map(input.requested.map(r => [r.taskId, r]));
  const affected = new Set(requests.keys());
  // Downstream closure; unaffected committed tasks remain capacity constraints.
  let grew = true;
  while (grew) { grew = false; for (const d of input.dependencies) if (affected.has(d.predecessorId) && !affected.has(d.successorId)) {
    affected.add(d.successorId); grew = true;
  } }
  result.affected = [...affected].sort();
  const occupied = new Map<string, Interval[]>();
  const reserve = (ids: string[], interval: Interval) => new Set(ids.map(id => resourceMap.get(id)?.capacityId ?? id))
    .forEach(id => occupied.set(id, [...(occupied.get(id) ?? []), interval]));
  for (const t of input.tasks) {
    const fixed = !affected.has(t.id) || t.locked || t.commitment === "STARTED" || t.commitment === "DONE";
    if (fixed && t.committed) { result.forecasts[t.id] = t.committed; reserve(t.resourceIds, t.committed); }
  }
  const conflict = (taskId: string, code: string, message: string, relatedTaskId?: string) =>
    result.conflicts.push({ taskId, code, message, ...(relatedTaskId ? { relatedTaskId } : {}) });
  const pending = new Set(affected);
  const compare = (a: CentralTask, b: CentralTask) => b.priority - a.priority ||
    (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  for (const id of [...pending]) if (!byId.has(id)) { conflict(id, "NOT_FOUND", "Opération introuvable."); pending.delete(id); }
  while (pending.size) {
    if (input.signal?.aborted) throw new Error("SIMULATION_CANCELLED");
    const ready = [...pending].map(id => byId.get(id)!).filter(t =>
      input.dependencies.filter(d => d.successorId === t.id).every(d => !pending.has(d.predecessorId))).sort(compare);
    if (!ready.length) { for (const id of pending) conflict(id, "DEPENDENCY_CYCLE", "Les dépendances forment un cycle."); break; }
    for (const t of ready) {
      pending.delete(t.id);
      if (t.locked || t.commitment === "STARTED" || t.commitment === "DONE") {
        if (requests.has(t.id)) conflict(t.id, "LOCKED", "Une opération commencée ou verrouillée conserve son créneau.");
        continue;
      }
      if (!t.estimate || t.estimate.remainingMinutes <= 0) { conflict(t.id, "DURATION_MISSING", "Durée à définir."); continue; }
      const req = requests.get(t.id);
      let ids = req?.autoAssign ? [...new Set(t.eligibleResourceIds)].filter(id => {
        const resource = resourceMap.get(id);
        return resource && (!resource.qualifiedTaskIds || resource.qualifiedTaskIds.includes(t.id));
      }).sort() : req?.resourceIds ?? t.resourceIds;
      const resources = ids.map(id => resourceMap.get(id)).filter((r): r is Resource => !!r);
      if (!ids.length || resources.length !== ids.length) { conflict(t.id, "RESOURCE_MISSING", "Ressource ou calendrier à définir."); continue; }
      if (ids.some(id => !t.eligibleResourceIds.includes(id)) ||
          resources.some(r => r.qualifiedTaskIds && !r.qualifiedTaskIds.includes(t.id))) {
        conflict(t.id, "RESOURCE_NOT_QUALIFIED", "La ressource n'est pas qualifiée pour cette opération."); continue;
      }
      let earliest = Math.max(ms(input.from), t.earliestStart ? ms(t.earliestStart) : 0, req ? ms(req.earliestStart) : 0);
      if (!Number.isFinite(earliest)) { conflict(t.id, "DATE_INVALID", "Date de disponibilité manquante."); continue; }
      let blocked = false;
      for (const d of input.dependencies.filter(d => d.successorId === t.id)) {
        const parent = byId.get(d.predecessorId);
        if (d.transferQuantity !== null && d.releasedQuantity >= d.transferQuantity) continue;
        const date = parent?.commitment==='DONE'&&parent.actual?.end?{start:parent.actual.end,end:parent.actual.end}:result.forecasts[d.predecessorId] ?? parent?.forecast ?? parent?.committed;
        if (!date || result.conflicts.some(c => c.taskId === d.predecessorId)) {
          conflict(t.id, "PREDECESSOR_UNAVAILABLE", "Un prérequis n'a pas de disponibilité réalisable.", d.predecessorId); blocked = true; break;
        }
        earliest = Math.max(earliest, ms(date.end) + d.lagMinutes * 60000);
      }
      if (blocked) continue;
      // Unresolved physical blockers require a dated availability supplied by the owning module.
      if (t.blockers.length && !t.earliestStart) { conflict(t.id, "PREREQUISITE_MISSING", t.blockers.join(" · ")); continue; }
      const alternatives = req?.autoAssign ? resources.flatMap(resource => {
        const slot = capacitySlot([resource], occupied, earliest, t.estimate!.remainingMinutes);
        return slot ? [{ slot, id: resource.id }] : [];
      }).sort((a,b) => ms(a.slot.end)-ms(b.slot.end) || ms(a.slot.start)-ms(b.slot.start) || a.id.localeCompare(b.id)) : [];
      const slot = req?.autoAssign ? alternatives[0]?.slot : capacitySlot(resources, occupied, earliest, t.estimate.remainingMinutes);
      if (!slot) { conflict(t.id, "NO_CAPACITY", "Aucun créneau réalisable dans les calendriers chargés."); continue; }
      if (req?.autoAssign) ids = [alternatives[0].id];
      reserve(ids, slot); result.forecasts[t.id] = slot;
      if (!t.committed || t.committed.start !== slot.start || t.committed.end !== slot.end ||
        ids.join("|") !== t.resourceIds.join("|")) result.changes.push({ taskId: t.id, before: t.committed, beforeResourceIds: t.resourceIds, after: slot, resourceIds: ids });
    }
  }
  // A fixed downstream commitment that has become impossible is surfaced; never silently moved.
  for (const d of input.dependencies) {
    const child = byId.get(d.successorId);
    const before = result.forecasts[d.predecessorId], after = result.forecasts[d.successorId];
    if (child?.locked && before && after && ms(before.end) + d.lagMinutes * 60000 > ms(after.start) &&
      !(d.transferQuantity !== null && d.releasedQuantity >= d.transferQuantity))
      conflict(child.id, "LOCKED_DEPENDENCY", "Le créneau verrouillé précède la disponibilité du prérequis.", d.predecessorId);
  }
  result.feasible = !result.conflicts.length;
  return result;
}
export function intervalsOverlap(a: Interval, b: Interval): boolean { return intersects(a, b); }
