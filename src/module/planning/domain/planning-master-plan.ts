import type { CentralSnapshot, CentralTask, Interval, Resource } from '../types/planning-central.types';
import type { MasterPlan, MasterPlanCapacity, MasterPlanOrder, MasterPlanOrderSource, MasterPlanPeriod } from '../types/planning-master-plan.types';

type NumericInterval = { start: number; end: number };
const numeric = (interval: Interval): NumericInterval => ({ start: Date.parse(interval.start), end: Date.parse(interval.end) });
const minutes = (value: number) => Math.round(value * 100) / 100;
const unique = <T>(items: T[]) => [...new Set(items)];
const civilFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const civilDay = (instant: string) => {
  const parts = civilFormatter.formatToParts(new Date(instant));
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

/** Calendar intervals are normalized before intersections: aliases never add capacity. */
function union(intervals: NumericInterval[]): NumericInterval[] {
  const result: NumericInterval[] = [];
  for (const interval of intervals.filter(i => i.end > i.start).sort((a, b) => a.start - b.start)) {
    const previous = result[result.length - 1];
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
}
function intersection(left: NumericInterval[], right: NumericInterval[]): NumericInterval[] {
  const result: NumericInterval[] = [];
  let a = 0, b = 0;
  while (a < left.length && b < right.length) {
    const start = Math.max(left[a].start, right[b].start), end = Math.min(left[a].end, right[b].end);
    if (end > start) result.push({ start, end });
    if (left[a].end < right[b].end) a++; else b++;
  }
  return result;
}
const length = (intervals: NumericInterval[]) => intervals.reduce((sum, interval) => sum + (interval.end - interval.start) / 60000, 0);
const inPeriod = (interval: Interval, period: MasterPlanPeriod) => Date.parse(interval.start) < Date.parse(period.end) && Date.parse(interval.end) > Date.parse(period.start);
const periodOf = (date: string | null, periods: MasterPlanPeriod[]) => date === null ? null : (() => {
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00Z` : date), index = periods.findIndex(p => at >= Date.parse(p.start) && at < Date.parse(p.end));
  return index < 0 ? null : index;
})();
const lastEnd = (tasks: CentralTask[], kind: 'committed' | 'forecast') => {
  // A partial route cannot be presented as the completion date of the OF.
  if (!tasks.length || tasks.some(task => !task[kind] && !(kind === 'forecast' && task.committed))) return null;
  return tasks.map(task => (task[kind] ?? task.committed)!.end).sort().at(-1) ?? null;
};

function projectOrder(order: MasterPlanOrderSource, tasks: CentralTask[], periods: MasterPlanPeriod[]): MasterPlanOrder {
  const route = tasks.filter(task => task.source !== 'PROGRAMMING');
  const unplaced = route.filter(task => task.commitment !== 'DONE' && !task.committed).length;
  const missingOperations = Math.max(0, order.operationCount - route.filter(task => task.source === 'OPERATION').length);
  const missingDuration = route.filter(task => task.commitment !== 'DONE' && !task.estimate).length + missingOperations;
  const issues = unique([...route.flatMap(task => task.blockers), ...order.forecastIssues]);
  if (!order.operationCount || missingOperations) issues.push('Opérations non définies ou incomplètes dans le planning.');
  if (missingDuration) issues.push(`${missingDuration} durée(s) à renseigner.`);
  if (!order.due) issues.push('Échéance à définir.');
  const completeRoute = order.operationCount > 0 && !missingOperations;
  const forecastEnd = completeRoute ? lastEnd(route, 'forecast') : null, committedEnd = completeRoute ? lastEnd(route, 'committed') : null;
  if (order.due && (forecastEnd ?? committedEnd) && civilDay((forecastEnd ?? committedEnd)!) > order.due)
    issues.push('Fin prévue après l’échéance active.');
  return { ...order, period: periodOf(order.due, periods), committedEnd, forecastEnd, unplaced, missingDuration,
    readiness: completeRoute && route.every(task => task.readiness === 'READY') ? 'READY' : 'MISSING', issues };
}

function projectCapacity(aliases: Resource[], tasks: CentralTask[], periods: MasterPlanPeriod[], forecastsKnown: boolean): MasterPlanCapacity {
  const primary = aliases.find(resource => resource.id === resource.capacityId) ?? aliases[0];
  const issues: string[] = [];
  let openings = union(primary.availability.map(numeric));
  const configured = primary.calendarConfigured === true;
  const enabled = primary.capacityEnabled !== false && (!primary.capacityId || primary.id === primary.capacityId);
  if (!configured) issues.push('Calendrier d’ouverture à définir.');
  if (!enabled) { openings = []; issues.push('Ressource indisponible ou retirée de la planification.'); }
  for (const alias of aliases) {
    if (alias === primary || !alias.calendarConfigured) continue;
    const available = union(alias.availability.map(numeric));
    if (JSON.stringify(available) !== JSON.stringify(openings)) {
      if (!issues.includes('Calendriers machine/postes différents : capacité commune retenue.'))
        issues.push('Calendriers machine/postes différents : capacité commune retenue.');
      openings = intersection(openings, available);
    }
  }
  const aliasIds = new Set(aliases.map(resource => resource.id));
  const allocated = tasks.filter(task => task.resourceIds.some(id => aliasIds.has(id)));
  const projected = tasks.filter(task => task.commitment !== 'DONE'
    && task.forecastResourceIds?.some(id => aliasIds.has(id)));
  const closures = union(aliases.flatMap(resource => resource.unavailability?.map(numeric) ?? []));
  return {
    id: primary.capacityId ?? primary.id, label: primary.label, kind: primary.kind as MasterPlanCapacity['kind'], issues,
    cells: periods.map(period => {
      const range = [numeric(period)], available = intersection(openings, range);
      const relevant = allocated.filter(task => task.committed && inPeriod(task.committed, period));
      const sum = () => minutes(relevant.reduce((total, task) => {
        return total + length(intersection(intersection([numeric(task.committed!)], range), available));
      }, 0));
      const capacityMinutes = configured ? minutes(length(available)) : null;
      const predicted = projected.filter(task => task.forecast && inPeriod(task.forecast, period));
      const committedMinutes = configured ? sum() : null;
      const forecastMinutes = configured && forecastsKnown ? minutes(predicted.reduce((total, task) =>
        total + length(intersection(intersection([numeric(task.forecast!)], range), available)), 0)) : null;
      const cellIssues: string[] = [];
      if (capacityMinutes === 0 && relevant.length) cellIssues.push('Engagement sans ouverture disponible.');
      if (relevant.some(task => task.committed && length(intersection(intersection([numeric(task.committed)], range), closures)) > 0))
        cellIssues.push('Un engagement recouvre une indisponibilité.');
      if (predicted.some(task => task.forecast && length(intersection(intersection([numeric(task.forecast)], range), closures)) > 0))
        cellIssues.push('Une prévision recouvre une indisponibilité : recalcul nécessaire.');
      const linked = [...relevant, ...predicted];
      return { capacityMinutes, committedMinutes, forecastMinutes,
        ratio: capacityMinutes && committedMinutes !== null ? minutes(committedMinutes / capacityMinutes * 100) : null,
        taskIds: unique(linked.map(task => task.id)), ofIds: unique(linked.flatMap(task => task.ofId === null ? [] : [task.ofId])), issues: cellIssues };
    }),
  };
}

/** This is a source-backed projection, never a second scheduling or stock ledger. */
export function projectMasterPlan(snapshot: CentralSnapshot, sources: MasterPlanOrderSource[], periods: MasterPlanPeriod[]): MasterPlan {
  const byOf = new Map<number, CentralTask[]>();
  for (const task of snapshot.tasks) if (task.ofId !== null) byOf.set(task.ofId, [...(byOf.get(task.ofId) ?? []), task]);
  const orders = sources.map(order => projectOrder(order, byOf.get(order.id) ?? [], periods));
  const physical = new Map<string, Resource[]>();
  for (const resource of snapshot.resources) if (resource.kind !== 'SUPPLIER') {
    const id = resource.capacityId ?? resource.id;
    physical.set(id, [...(physical.get(id) ?? []), resource]);
  }
  const unfinished = snapshot.tasks.filter(task => task.commitment !== 'DONE');
  const knownResources = new Set(snapshot.resources.map(resource => resource.id));
  const unallocatedForecasts = unfinished.filter(task => task.forecast && !task.external
    && (!task.forecastResourceIds?.length || task.forecastResourceIds.some(id => !knownResources.has(id)))).length;
  const forecastsKnown = snapshot.forecastState?.status === 'READY' && unallocatedForecasts === 0;
  const capacities = [...physical.values()].map(aliases => projectCapacity(aliases, snapshot.tasks, periods, forecastsKnown));
  const warnings = ['OF existants uniquement : les objectifs ne sont pas une prévision commerciale.',
    'Objectifs classés à la première échéance active de l’OF ; les quantités de livraison restent dans les affaires.'];
  if (unallocatedForecasts) warnings.push(`${unallocatedForecasts} prévision(s) sans ressource connue : charge prévisionnelle à recalculer.`);
  if (snapshot.forecastState && snapshot.forecastState.status !== 'READY') warnings.push('Prévisions non actualisées : consultez l’état du calcul.');
  return {
    apiVersion: 1, readOnly: true, scope: 'ACTIVE_PRODUCER_OFS', revision: snapshot.revision, generatedAt: snapshot.generatedAt,
    timezone: 'Europe/Paris', from: periods[0].start, to: periods.at(-1)!.end, periods, orders, capacities,
    summary: { activeOrders: orders.length, undatedOrders: orders.filter(order => !order.due).length,
      unplacedOperations: unfinished.filter(task => !task.committed).length,
      unassignedOperations: unfinished.filter(task => !task.resourceIds.length).length,
      missingDuration: unfinished.filter(task => !task.estimate).length,
      unknownCalendars: capacities.filter(capacity => capacity.cells[0].capacityMinutes === null).length,
      overdueOrders: orders.filter(order => order.due && order.due < civilDay(snapshot.generatedAt)).length,
      unallocatedForecasts },
    warnings, forecastCalculatedAt: snapshot.forecastState?.calculatedAt ?? null,
  };
}
