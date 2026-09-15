import type { CentralTask, Dependency, Interval, Resource, ScheduleResult } from "../types/planning-central.types";
import {externalCompletion} from './external-schedule';
import { dependencyClosure, dependencyIndex } from './central-dependencies';
const ms = (v: string) => Date.parse(v);
const iso = (v: number) => new Date(v).toISOString();
function intersects(a: Interval, b: Interval) { return ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end); }
type NumericInterval = { start: number; end: number };
function normalized(intervals: NumericInterval[]): NumericInterval[] {
  const result: NumericInterval[] = [];
  for (const interval of intervals.filter(w => w.end > w.start).sort((a,b) => a.start-b.start || a.end-b.end)) {
    const last = result[result.length-1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end,interval.end);
    else result.push({...interval});
  }
  return result;
}
const calendarCache = new WeakMap<Interval[], NumericInterval[]>();
function calendarWindows(resource: Resource) {
  let result = calendarCache.get(resource.availability);
  if (!result) {
    result = normalized(resource.availability.map(i => ({start:ms(i.start),end:ms(i.end)})));
    calendarCache.set(resource.availability,result);
  }
  return result;
}
/** Sweep shared opening intervals and reservations once; closed shifts may be bridged, reservations may not. */
export function capacitySlot(resources: Resource[], occupied: Map<string, Interval[]>, earliest: number, minutes: number): Interval | null {
  if (!resources.length || minutes <= 0 || !Number.isFinite(minutes) || !Number.isFinite(earliest)) return null;
  let windows = calendarWindows(resources[0]);
  for (const r of resources.slice(1)) {
    const other = calendarWindows(r), shared: NumericInterval[] = [];
    let a = 0, b = 0;
    while (a < windows.length && b < other.length) {
      const start = Math.max(windows[a].start,other[b].start), end = Math.min(windows[a].end,other[b].end);
      if (end > start) shared.push({start,end});
      if (windows[a].end < other[b].end) a++; else b++;
    }
    windows = shared;
  }
  const blocked = normalized([...new Set(resources.map(r => r.capacityId ?? r.id))]
    .flatMap(id => occupied.get(id) ?? []).map(i => ({start:ms(i.start),end:ms(i.end)})).filter(i => i.end > earliest));
  const free: NumericInterval[] = [];
  let blockIndex = 0;
  for (const window of windows) {
    let start = Math.max(window.start,earliest);
    if (window.end <= start) continue;
    while (blockIndex < blocked.length && blocked[blockIndex].end <= start) blockIndex++;
    for (let i = blockIndex; i < blocked.length && blocked[i].start < window.end; i++) {
      if (blocked[i].start > start) free.push({start,end:blocked[i].start});
      start = Math.max(start,blocked[i].end);
      if (start >= window.end) break;
    }
    if (start < window.end) free.push({start,end:window.end});
  }
  let remaining = minutes * 60000, first: number | null = null, lastEnd = earliest, barrier = 0;
  for (const window of free) {
    while (barrier < blocked.length && blocked[barrier].end <= lastEnd) barrier++;
    if (blocked[barrier]?.start < window.start && blocked[barrier].end > lastEnd) { first = null; remaining = minutes * 60000; }
    if (first === null) first = window.start;
    const used = Math.min(remaining,window.end-window.start);
    remaining -= used;
    if (remaining <= 0) return {start:iso(first),end:iso(window.start+used)};
    lastEnd = window.end;
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
  const { incoming, outgoing } = dependencyIndex(input.dependencies);
  const affected = dependencyClosure(input.dependencies,[...requests.keys()],'downstream');
  result.affected = [...affected].sort();
  const occupied = new Map<string, Interval[]>();
  const reserve = (ids: string[], interval: Interval) => new Set(ids.map(id => resourceMap.get(id)?.capacityId ?? id))
    .forEach(id => { if (!occupied.has(id)) occupied.set(id,[]); occupied.get(id)!.push(interval); });
  for (const t of input.tasks) {
    const fixed = !affected.has(t.id) || t.locked || t.commitment === "STARTED" || t.commitment === "DONE";
    if (fixed && t.committed) { result.forecasts[t.id] = t.committed; if(!t.external)reserve(t.resourceIds, t.committed); }
  }
  const conflicted = new Set<string>();
  const conflict = (taskId: string, code: string, message: string, relatedTaskId?: string) => {
    conflicted.add(taskId); result.conflicts.push({ taskId, code, message, ...(relatedTaskId ? { relatedTaskId } : {}) });
  };
  const predecessorDate = (parent: CentralTask | undefined) => {
    if (!parent) return null;
    if (parent.external) {
      if (affected.has(parent.id)) return result.forecasts[parent.id];
      const projected=externalCompletion(parent.external.packages,parent.quantity,parent.actual?.start??parent.committed?.start??input.from,input.resources,input.from);
      return projected.fullReadyAt ? {start:parent.actual?.start??parent.committed?.start??input.from,end:projected.fullReadyAt} : null;
    }
    return parent.commitment==='DONE'&&parent.actual?.end ? {start:parent.actual.end,end:parent.actual.end} : result.forecasts[parent.id]??parent.forecast??parent.committed;
  };
  const pending = new Set(affected);
  const compare = (a: CentralTask, b: CentralTask) => b.priority - a.priority ||
    (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  for (const id of [...pending]) if (!byId.has(id)) { conflict(id, "NOT_FOUND", "Opération introuvable."); pending.delete(id); }
  const waiting = new Map([...pending].map(id => [id,(incoming.get(id) ?? []).filter(d => pending.has(d.predecessorId)).length]));
  let readyIds = [...pending].filter(id => waiting.get(id) === 0);
  while (pending.size) {
    if (input.signal?.aborted) throw new Error("SIMULATION_CANCELLED");
    const ready = readyIds.map(id => byId.get(id)!).sort(compare);
    readyIds = [];
    if (!ready.length) { for (const id of pending) conflict(id, "DEPENDENCY_CYCLE", "Les dépendances forment un cycle."); break; }
    for (const t of ready) {
      pending.delete(t.id);
      for (const d of outgoing.get(t.id) ?? []) if (pending.has(d.successorId)) {
        const remaining = waiting.get(d.successorId)! - 1;
        waiting.set(d.successorId,remaining);
        if (remaining === 0) readyIds.push(d.successorId);
      }
      if(t.external){
        let earliest=Math.max(ms(input.from),ms(requests.get(t.id)?.earliestStart??input.from));
        let unavailable=false;
        for(const d of incoming.get(t.id) ?? []){
          if(d.releasedQuantity>=t.quantity)continue;
          const parent=byId.get(d.predecessorId),date=predecessorDate(parent);
          if(!date||conflicted.has(d.predecessorId)){conflict(t.id,'PREDECESSOR_UNAVAILABLE','Le départ attend une étape précédente.',d.predecessorId);unavailable=true;break;}
          earliest=Math.max(earliest,ms(date.end)+d.lagMinutes*60000);
        }
        if(unavailable)continue;
        const requested=requests.get(t.id),actual=t.external.packages.flatMap(p=>p.departedAt?[p.departedAt]:[]).sort()[0];
        const projection=externalCompletion(t.external.packages,t.quantity,actual??iso(earliest),input.resources,input.from);
        if(!projection.fullReadyAt){for(const issue of projection.issues)conflict(t.id,'EXTERNAL_RETURN_UNAVAILABLE',issue);continue;}
        if(requested?.resourceIds && requested.resourceIds.join('|')!==t.resourceIds.join('|')){conflict(t.id,'EXTERNAL_SUPPLIER_FIXED','Le fournisseur est celui de la commande liée.');continue;}
        const slot={start:actual??iso(earliest),end:projection.fullReadyAt};
        if(ms(slot.end)<=ms(slot.start))slot.end=iso(ms(slot.start)+1);
        result.forecasts[t.id]=slot;
        if(!actual&&!t.locked&&t.commitment!=='DONE'&&t.commitment!=='STARTED'&&(!t.committed||t.committed.start!==slot.start||t.committed.end!==slot.end))
          result.changes.push({taskId:t.id,before:t.committed,beforeResourceIds:t.resourceIds,after:slot,resourceIds:t.resourceIds});
        continue;
      }
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
      for (const d of incoming.get(t.id) ?? []) {
        const parent = byId.get(d.predecessorId);
        // A partial transfer permits execution of that batch; the full-operation
        // finish forecast still waits for the balance from an external operation.
        if (d.transferQuantity !== null && d.releasedQuantity >= d.transferQuantity &&
          (!parent?.external || d.releasedQuantity>=t.quantity)) continue;
        const date = predecessorDate(parent);
        if (!date || conflicted.has(d.predecessorId)) {
          conflict(t.id, "PREDECESSOR_UNAVAILABLE", "Un prérequis n'a pas de disponibilité réalisable.", d.predecessorId); blocked = true; break;
        }
        earliest = Math.max(earliest, ms(date.end) + d.lagMinutes * 60000);
      }
      if (blocked) continue;
      // Unresolved physical blockers require a dated availability supplied by the owning module.
      if (t.blockers.length && !t.earliestStart) { conflict(t.id, "PREREQUISITE_MISSING", t.blockers.join(" · ")); continue; }
      const alternatives = req?.autoAssign ? resources.flatMap(resource => {
        const minutes = t.resourceEstimates?.[resource.id]?.remainingMinutes ?? t.estimate!.remainingMinutes;
        const slot = capacitySlot([resource], occupied, earliest, minutes);
        return slot ? [{ slot, id: resource.id }] : [];
      }).sort((a,b) => ms(a.slot.end)-ms(b.slot.end) || ms(a.slot.start)-ms(b.slot.start) || a.id.localeCompare(b.id)) : [];
      const duration = ids.length === 1 ? t.resourceEstimates?.[ids[0]]?.remainingMinutes ?? t.estimate.remainingMinutes : t.estimate.remainingMinutes;
      const slot = req?.autoAssign ? alternatives[0]?.slot : capacitySlot(resources, occupied, earliest, duration);
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
    if ((child?.locked||child?.commitment==='STARTED') && before && after && ms(before.end) + d.lagMinutes * 60000 > ms(after.start) &&
      !(d.transferQuantity !== null && d.releasedQuantity >= d.transferQuantity && (!byId.get(d.predecessorId)?.external||d.releasedQuantity>=child.quantity)))
      conflict(child.id, "LOCKED_DEPENDENCY", "Le créneau verrouillé précède la disponibilité du prérequis.", d.predecessorId);
  }
  result.feasible = !result.conflicts.length;
  return result;
}
export function intervalsOverlap(a: Interval, b: Interval): boolean { return intersects(a, b); }
