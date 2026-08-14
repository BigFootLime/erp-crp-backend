import type {
  PlanningAction,
  PlanningCapacityCell,
  PlanningConflict,
  PlanningExecutionIntelligence,
  PlanningMetric,
  PlanningPreferences,
  PlanningReliability,
  PlanningStopCause,
} from "../types/planning-intelligence.types";

export type PlanningIntelligenceEventRow = {
  event_id: string;
  of_id: number | null;
  of_numero: string | null;
  operation_id: string | null;
  phase: number | null;
  designation: string | null;
  event_status: string;
  operation_status: string | null;
  start_ts: string;
  end_ts: string;
  updated_at: string;
  operation_ended_at: string | null;
  planned_hours: number | null;
  machine_id: string | null;
  machine_code: string | null;
  machine_name: string | null;
  machine_available: boolean | null;
  allow_overlap: boolean;
};

export type PlanningIntelligencePointageRow = {
  pointage_id: string;
  of_id: number;
  operation_id: string | null;
  machine_id: string | null;
  machine_code: string | null;
  activity_code: string | null;
  activity_label: string | null;
  activity_is_productive: boolean | null;
  is_running: boolean;
  start_ts: string;
  end_ts: string;
  duration_minutes: number;
  comment: string | null;
  updated_at: string;
};

export type PlanningQuantityRow = {
  unit: string;
  qty_good: number;
  qty_scrap: number;
  qty_rework: number;
  freshness_at: string | null;
};

export type PlanningWipRow = {
  of_id: number;
  of_numero: string;
  operation_id: string | null;
  machine_id: string | null;
  started_at: string | null;
  due_date: string | null;
};

export type PlanningCapacityRawRow = {
  machine_id: string;
  machine_code: string;
  machine_name: string;
  week_start: string;
  available_minutes: number | null;
  unavailable_minutes: number;
  calendar_count: number;
  calendar_freshness_at: string | null;
  planned_event: PlanningIntelligenceEventRow | null;
  planned_minutes: number;
  actual_minutes: number;
};

export type PlanningIntelligenceSnapshot = {
  events: PlanningIntelligenceEventRow[];
  pointages: PlanningIntelligencePointageRow[];
  quantities: PlanningQuantityRow[];
  wip: PlanningWipRow[];
  capacity: PlanningCapacityRawRow[];
};

export type PlanningIntelligenceCapabilities = PlanningExecutionIntelligence["capabilities"];

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

function latest(values: Array<string | null | undefined>): string | null {
  let latestValue: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latestValue = new Date(ms).toISOString();
    }
  }
  return latestValue;
}

function metric(params: Omit<PlanningMetric, "missing"> & { missing?: string[] }): PlanningMetric {
  return { ...params, missing: params.missing ?? [] };
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function buildMetrics(params: {
  snapshot: PlanningIntelligenceSnapshot;
  now: Date;
  agedWipDays: number;
}): PlanningExecutionIntelligence["kpis"] {
  const { snapshot, now, agedWipDays } = params;
  const dueEvents = uniqueBy(
    snapshot.events.filter((event) => {
      const due = Date.parse(event.end_ts);
      return Number.isFinite(due) && due <= now.getTime() && event.event_status !== "CANCELLED";
    }),
    (event) => event.operation_id ?? event.event_id
  );
  const onTime = dueEvents.filter((event) => {
    if (!event.operation_ended_at) return false;
    return Date.parse(event.operation_ended_at) <= Date.parse(event.end_ts);
  }).length;

  const completedOperations = uniqueBy(
    snapshot.events.filter((event) => Boolean(event.operation_id && event.operation_ended_at)),
    (event) => event.operation_id as string
  );
  const operations = uniqueBy(
    snapshot.events.filter((event) => Boolean(event.operation_id)),
    (event) => event.operation_id as string
  );
  const knownPlanned = operations.filter((event) => typeof event.planned_hours === "number" && event.planned_hours > 0);
  const plannedHours = knownPlanned.reduce((sum, event) => sum + (event.planned_hours ?? 0), 0);
  const actualMinutes = snapshot.pointages.reduce((sum, pointage) => sum + pointage.duration_minutes, 0);
  const wip = uniqueBy(snapshot.wip, (row) => String(row.of_id));
  const agedCutoff = now.getTime() - agedWipDays * 86_400_000;
  const agedWip = wip.filter((row) => row.started_at && Date.parse(row.started_at) < agedCutoff);

  const quantitiesHaveOneUnit = snapshot.quantities.length === 1
    && snapshot.quantities[0]?.unit !== "UNSPECIFIED";
  const quantity = quantitiesHaveOneUnit ? snapshot.quantities[0] : null;
  const scrapDenominator = quantity ? quantity.qty_good + quantity.qty_scrap : 0;
  const scrapValue = quantity && scrapDenominator > 0 ? round((quantity.qty_scrap / scrapDenominator) * 100) : null;
  const freshness = latest([
    ...snapshot.events.map((row) => row.updated_at),
    ...snapshot.pointages.map((row) => row.updated_at),
    ...snapshot.quantities.map((row) => row.freshness_at),
  ]);

  return {
    schedule_adherence: metric({
      value: dueEvents.length ? round((onTime / dueEvents.length) * 100) : null,
      unit: "% des opérations planifiées dues",
      numerator: dueEvents.length ? onTime : null,
      denominator: dueEvents.length || null,
      definition: "Opérations terminées au plus tard à la fin du créneau / opérations planifiées dont le créneau est échu.",
      source: ["public.planning_events", "public.of_operations.ended_at"],
      freshness_at: freshness,
      reliability: dueEvents.length ? "VERIFIED" : "UNAVAILABLE",
      missing: dueEvents.length ? [] : ["Aucune opération planifiée arrivée à échéance sur la période."],
    }),
    throughput: metric({
      value: completedOperations.length,
      unit: "opérations terminées",
      numerator: completedOperations.length,
      denominator: null,
      definition: "Nombre d'opérations distinctes dont la fin réelle appartient à la période.",
      source: ["public.of_operations.ended_at"],
      freshness_at: freshness,
      reliability: "VERIFIED",
    }),
    wip: metric({
      value: wip.length,
      unit: "OF en cours",
      numerator: wip.length,
      denominator: null,
      definition: "OF non terminés ayant une opération ou un pointage en cours.",
      source: ["public.ordres_fabrication", "public.of_operations", "public.production_pointages"],
      freshness_at: freshness,
      reliability: "VERIFIED",
    }),
    aged_wip: metric({
      value: agedWip.length,
      unit: `OF en cours depuis plus de ${agedWipDays} jours`,
      numerator: agedWip.length,
      denominator: wip.length || null,
      definition: `OF en cours dont le premier démarrage traçable date de plus de ${agedWipDays} jours.`,
      source: ["public.ordres_fabrication.date_lancement_reelle", "public.production_pointages.start_ts"],
      freshness_at: freshness,
      reliability: wip.some((row) => !row.started_at) ? "PARTIAL" : "VERIFIED",
      missing: wip.some((row) => !row.started_at) ? ["Certains OF en cours n'ont pas de date de démarrage traçable."] : [],
    }),
    scrap_rate: metric({
      value: scrapValue,
      unit: "% des quantités bonnes + rebut",
      numerator: quantity ? quantity.qty_scrap : null,
      denominator: quantity && scrapDenominator > 0 ? scrapDenominator : null,
      definition: "Quantité rebut déclarée / (quantité bonne + quantité rebut), après compensations, pour une unité homogène.",
      source: ["public.production_quantity_declarations"],
      freshness_at: latest(snapshot.quantities.map((row) => row.freshness_at)),
      reliability: quantitiesHaveOneUnit && scrapDenominator > 0 ? "VERIFIED" : snapshot.quantities.length ? "PARTIAL" : "UNAVAILABLE",
      missing: !snapshot.quantities.length
        ? ["Aucune déclaration de quantité sur la période."]
        : !quantitiesHaveOneUnit
          ? [snapshot.quantities.some((row) => row.unit === "UNSPECIFIED")
              ? "Une unité de quantité manque : aucun taux global trompeur n'est calculé."
              : "Plusieurs unités sont présentes : aucun taux global trompeur n'est calculé."]
          : scrapDenominator <= 0
            ? ["Le dénominateur bonne + rebut est nul."]
            : [],
    }),
    planned_time: metric({
      value: knownPlanned.length ? round(plannedHours) : null,
      unit: "heures prévues",
      numerator: knownPlanned.length ? round(plannedHours) : null,
      denominator: operations.length || null,
      definition: "Somme des temps prévus strictement positifs des opérations distinctes planifiées sur la période.",
      source: ["public.of_operations.temps_total_planned"],
      freshness_at: freshness,
      reliability: !operations.length ? "UNAVAILABLE" : knownPlanned.length === operations.length ? "VERIFIED" : "PARTIAL",
      missing: operations.length > knownPlanned.length ? [`${operations.length - knownPlanned.length} opération(s) sans temps prévu explicite.`] : [],
    }),
    actual_time: metric({
      value: snapshot.pointages.length ? round(actualMinutes / 60) : null,
      unit: "heures constatées",
      numerator: snapshot.pointages.length ? actualMinutes : null,
      denominator: null,
      definition: "Somme des segments de pointage constatés, bornés à la période, convention [début, fin).",
      source: ["public.production_pointages"],
      freshness_at: latest(snapshot.pointages.map((row) => row.updated_at)),
      reliability: snapshot.pointages.length ? "VERIFIED" : "UNAVAILABLE",
      missing: snapshot.pointages.length ? [] : ["Aucun pointage constaté sur la période."],
    }),
  };
}

function buildCapacity(rows: PlanningCapacityRawRow[]): PlanningCapacityCell[] {
  const groups = new Map<string, PlanningCapacityCell>();
  for (const row of rows) {
    const key = `${row.machine_id}:${row.week_start}`;
    let cell = groups.get(key);
    if (!cell) {
      const missing = row.calendar_count === 0
        ? ["Aucun calendrier de production actif."]
        : row.calendar_count > 1
          ? ["Plusieurs calendriers actifs sans affectation machine : capacité indisponible."]
          : [];
      cell = {
        machine_id: row.machine_id,
        machine_code: row.machine_code,
        machine_name: row.machine_name,
        week_start: row.week_start,
        available_minutes: row.available_minutes,
        unavailable_minutes: row.unavailable_minutes,
        planned_minutes: 0,
        actual_minutes: 0,
        utilization_pct: null,
        state: row.available_minutes === null ? "UNAVAILABLE" : "AVAILABLE",
        reliability: row.available_minutes === null ? "UNAVAILABLE" : "VERIFIED",
        missing,
        drilldown: [],
      };
      groups.set(key, cell);
    }
    cell.planned_minutes += row.planned_minutes;
    cell.actual_minutes += row.actual_minutes;
    if (row.planned_event) {
      cell.drilldown.push({
        event_id: row.planned_event.event_id,
        of_id: row.planned_event.of_id,
        of_numero: row.planned_event.of_numero,
        operation_id: row.planned_event.operation_id,
        phase: row.planned_event.phase,
        designation: row.planned_event.designation,
        planned_minutes: row.planned_minutes,
        start_ts: row.planned_event.start_ts,
        end_ts: row.planned_event.end_ts,
        status: row.planned_event.event_status,
      });
    }
  }
  for (const cell of groups.values()) {
    cell.planned_minutes = round(cell.planned_minutes, 0);
    cell.actual_minutes = round(cell.actual_minutes, 0);
    cell.drilldown = uniqueBy(cell.drilldown, (item) => item.event_id);
    if (cell.available_minutes === null) continue;
    if (cell.available_minutes <= 0) {
      if (cell.planned_minutes > 0) cell.state = "BOTTLENECK";
      continue;
    }
    cell.utilization_pct = round((cell.planned_minutes / cell.available_minutes) * 100, 1);
    if (cell.utilization_pct > 120) cell.state = "BOTTLENECK";
    else if (cell.utilization_pct > 100) cell.state = "OVERLOADED";
    else if (cell.utilization_pct >= 80) cell.state = "LOADED";
  }
  return [...groups.values()].sort((a, b) => a.week_start.localeCompare(b.week_start) || a.machine_code.localeCompare(b.machine_code));
}

function buildStops(pointages: PlanningIntelligencePointageRow[]): PlanningStopCause[] {
  const grouped = new Map<string, PlanningStopCause>();
  for (const row of pointages) {
    if (row.activity_is_productive !== false) continue;
    const code = row.activity_code ?? "UNCLASSIFIED_STOP";
    const current = grouped.get(code) ?? {
      code,
      label: row.activity_label ?? "Arrêt non classé",
      duration_minutes: 0,
      occurrences: 0,
      reason_missing_count: 0,
      source: "production_pointages" as const,
    };
    current.duration_minutes += row.duration_minutes;
    current.occurrences += 1;
    if (!row.activity_code) current.reason_missing_count += 1;
    grouped.set(code, current);
  }
  return [...grouped.values()]
    .map((row) => ({ ...row, duration_minutes: round(row.duration_minutes, 0) }))
    .sort((a, b) => b.duration_minutes - a.duration_minutes || a.code.localeCompare(b.code));
}

function buildConflicts(snapshot: PlanningIntelligenceSnapshot, now: Date): PlanningConflict[] {
  const conflicts: PlanningConflict[] = [];
  const byMachine = new Map<string, PlanningIntelligenceEventRow[]>();
  for (const event of snapshot.events) {
    if (!event.machine_id) continue;
    const bucket = byMachine.get(event.machine_id) ?? [];
    bucket.push(event);
    byMachine.set(event.machine_id, bucket);
    if (event.machine_available === false) {
      conflicts.push({
        id: `resource:${event.event_id}`,
        code: "RESOURCE_UNAVAILABLE",
        severity: "CRITICAL",
        explanation: `${event.machine_code ?? "Machine"} est indisponible mais porte le créneau ${event.of_numero ?? event.event_id}.`,
        next_action: "Réaffecter le créneau ou rendre la machine disponible après validation atelier.",
        machine_id: event.machine_id,
        machine_code: event.machine_code,
        event_ids: [event.event_id],
        of_ids: event.of_id ? [event.of_id] : [],
      });
    }
    if (event.operation_id && (!event.planned_hours || event.planned_hours <= 0)) {
      conflicts.push({
        id: `planned-time:${event.event_id}`,
        code: "MISSING_PLANNED_TIME",
        severity: "WARNING",
        explanation: `${event.of_numero ?? "OF"} phase ${event.phase ?? "?"} n'a pas de temps prévu explicite.`,
        next_action: "Compléter la gamme ou l'opération avant d'utiliser la charge comme engagement.",
        machine_id: event.machine_id,
        machine_code: event.machine_code,
        event_ids: [event.event_id],
        of_ids: event.of_id ? [event.of_id] : [],
      });
    }
  }
  for (const [machineId, events] of byMachine) {
    events.sort((a, b) => Date.parse(a.start_ts) - Date.parse(b.start_ts));
    for (let index = 1; index < events.length; index += 1) {
      const previous = events[index - 1];
      const current = events[index];
      if (Date.parse(current.start_ts) >= Date.parse(previous.end_ts)) continue;
      if (!current.allow_overlap && !previous.allow_overlap) continue;
      conflicts.push({
        id: `overlap:${previous.event_id}:${current.event_id}`,
        code: "SCHEDULE_OVERLAP",
        severity: "WARNING",
        explanation: `Chevauchement explicitement forcé sur ${current.machine_code ?? previous.machine_code ?? "la machine"}.`,
        next_action: "Vérifier la décision de chevauchement et documenter la capacité réellement disponible.",
        machine_id: machineId,
        machine_code: current.machine_code ?? previous.machine_code,
        event_ids: [previous.event_id, current.event_id],
        of_ids: [previous.of_id, current.of_id].filter((value): value is number => typeof value === "number"),
      });
    }
  }
  const plannedByOperation = new Map(snapshot.events.filter((row) => row.operation_id).map((row) => [row.operation_id as string, row]));
  for (const pointage of snapshot.pointages) {
    const planned = pointage.operation_id ? plannedByOperation.get(pointage.operation_id) : null;
    if (planned?.machine_id && pointage.machine_id && planned.machine_id !== pointage.machine_id) {
      conflicts.push({
        id: `machine-mismatch:${pointage.pointage_id}`,
        code: "ACTUAL_RESOURCE_MISMATCH",
        severity: "WARNING",
        explanation: `${planned.of_numero ?? "OF"} s'exécute sur ${pointage.machine_code ?? "une autre machine"} au lieu de ${planned.machine_code ?? "la machine planifiée"}.`,
        next_action: "Confirmer la réaffectation réelle ou corriger le planning avant la prochaine séquence.",
        machine_id: pointage.machine_id,
        machine_code: pointage.machine_code,
        event_ids: [planned.event_id],
        of_ids: [pointage.of_id],
      });
    }
    if (pointage.is_running && pointage.duration_minutes > 12 * 60) {
      conflicts.push({
        id: `long-running:${pointage.pointage_id}`,
        code: "LONG_RUNNING_EXECUTION",
        severity: "CRITICAL",
        explanation: `Un pointage est ouvert depuis ${round(pointage.duration_minutes / 60, 1)} h.`,
        next_action: "Le superviseur doit vérifier le poste et arrêter ou corriger le pointage, sans réécrire l'historique.",
        machine_id: pointage.machine_id,
        machine_code: pointage.machine_code,
        event_ids: planned ? [planned.event_id] : [],
        of_ids: [pointage.of_id],
      });
    }
  }
  return uniqueBy(conflicts, (item) => item.id);
}

function buildActions(params: {
  capacity: PlanningCapacityCell[];
  conflicts: PlanningConflict[];
  wip: PlanningWipRow[];
  now: Date;
  agedWipDays: number;
}): PlanningAction[] {
  const actions: PlanningAction[] = [];
  for (const conflict of params.conflicts) {
    actions.push({
      id: `conflict:${conflict.id}`,
      priority: conflict.severity === "CRITICAL" ? "P0" : "P1",
      title: conflict.explanation,
      explanation: conflict.next_action,
      owner_role: conflict.code === "LONG_RUNNING_EXECUTION" ? "SUPERVISOR" : "PLANNER",
      due_at: conflict.severity === "CRITICAL" ? params.now.toISOString() : null,
      action_path: conflict.of_ids[0] ? `/production/ordres-fabrication/${conflict.of_ids[0]}` : "/planning",
      machine_id: conflict.machine_id,
      of_id: conflict.of_ids[0] ?? null,
      operation_id: null,
    });
  }
  for (const cell of params.capacity.filter((row) => row.state === "OVERLOADED" || row.state === "BOTTLENECK")) {
    actions.push({
      id: `capacity:${cell.machine_id}:${cell.week_start}`,
      priority: cell.state === "BOTTLENECK" ? "P0" : "P1",
      title: `${cell.machine_code} à ${cell.utilization_pct ?? "?"} % la semaine du ${cell.week_start}`,
      explanation: "Ouvrir le drill-down, arbitrer les OF et replanifier avec une capacité réelle validée.",
      owner_role: "PLANNER",
      due_at: `${cell.week_start}T00:00:00.000Z`,
      action_path: `/planning?machine_id=${encodeURIComponent(cell.machine_id)}&week=${encodeURIComponent(cell.week_start)}`,
      machine_id: cell.machine_id,
      of_id: cell.drilldown[0]?.of_id ?? null,
      operation_id: cell.drilldown[0]?.operation_id ?? null,
    });
  }
  const cutoff = params.now.getTime() - params.agedWipDays * 86_400_000;
  for (const row of uniqueBy(params.wip, (item) => String(item.of_id)).filter((item) => item.started_at && Date.parse(item.started_at) < cutoff)) {
    actions.push({
      id: `aged-wip:${row.of_id}`,
      priority: "P1",
      title: `${row.of_numero} est un encours âgé`,
      explanation: "Identifier le blocage, affecter un responsable et dater la prochaine action.",
      owner_role: "SUPERVISOR",
      due_at: row.due_date,
      action_path: `/production/ordres-fabrication/${row.of_id}`,
      machine_id: row.machine_id,
      of_id: row.of_id,
      operation_id: row.operation_id,
    });
  }
  const rank = { P0: 0, P1: 1, P2: 2 } as const;
  return uniqueBy(actions, (item) => item.id).sort((a, b) => rank[a.priority] - rank[b.priority] || (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
}

export function defaultPlanningPreferences(): PlanningPreferences {
  return {
    timezone: "Europe/Paris",
    horizon_weeks: 6,
    view_mode: "WEEK",
    show_weekends: false,
    machine_ids: [],
    status_colors: {},
    client_color_overrides: {},
    updated_at: null,
  };
}

export function buildPlanningExecutionIntelligence(params: {
  snapshot: PlanningIntelligenceSnapshot;
  from: string;
  to: string;
  timezone: string;
  agedWipDays: number;
  capabilities: PlanningIntelligenceCapabilities;
  now?: Date;
}): PlanningExecutionIntelligence {
  const now = params.now ?? new Date();
  const capacity = buildCapacity(params.snapshot.capacity);
  const conflicts = buildConflicts(params.snapshot, now);
  const stopCauses = buildStops(params.snapshot.pointages);
  const kpis = buildMetrics({ snapshot: params.snapshot, now, agedWipDays: params.agedWipDays });
  const warnings = uniqueBy(
    [
      ...capacity.flatMap((cell) => cell.missing),
      ...Object.values(kpis).flatMap((value) => value.missing),
    ],
    (value) => value
  );
  const reliabilityValues: PlanningReliability[] = [
    ...Object.values(kpis).map((value) => value.reliability),
    ...capacity.map((value) => value.reliability),
  ];
  const reliability: PlanningReliability = reliabilityValues.every((value) => value === "UNAVAILABLE")
    ? "UNAVAILABLE"
    : reliabilityValues.some((value) => value !== "VERIFIED")
      ? "PARTIAL"
      : "VERIFIED";
  const freshness = latest([
    ...params.snapshot.events.map((row) => row.updated_at),
    ...params.snapshot.pointages.map((row) => row.updated_at),
    ...params.snapshot.quantities.map((row) => row.freshness_at),
    ...params.snapshot.capacity.map((row) => row.calendar_freshness_at),
  ]);

  return {
    metadata: {
      generated_at: now.toISOString(),
      period: { from: params.from, to: params.to, timezone: params.timezone },
      definition_version: "SOL-21.v1",
      sources: [
        "public.planning_events",
        "public.of_operations",
        "public.ordres_fabrication",
        "public.production_pointages",
        "public.production_quantity_declarations",
        "public.programmation_calendars",
      ],
      freshness_at: freshness,
      reliability,
      warnings,
    },
    capabilities: params.capabilities,
    kpis,
    capacity,
    stop_causes: stopCauses,
    conflicts,
    action_queue: buildActions({ capacity, conflicts, wip: params.snapshot.wip, now, agedWipDays: params.agedWipDays }),
  };
}
