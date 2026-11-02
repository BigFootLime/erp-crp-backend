import { capacitySlot } from "./central-scheduler";
import type {
  CentralSnapshot,
  Interval,
  Resource,
} from "../types/planning-central.types";
import type { IndustrialProposal } from "../types/industrial-plan.types";

export type RoutingStep = {
  article_id: string;
  operation_id: string;
  phase: number;
  label: string;
  kind: string;
  resource_ids: string[];
  setup_minutes: number | null;
  unit_minutes: number | null;
};
export type CapacityAlternative = {
  operation_id: string;
  resource: string;
  end: string;
};
export function placeIndustrialProposals(input: {
  proposals: IndustrialProposal[];
  routing: RoutingStep[];
  snapshot: CentralSnapshot;
  today: string;
  through: string;
  protectedSlots?: { resource: string; start: string; end: string }[];
}) {
  const occupied = new Map<string, Interval[]>(),
    resources = new Map(input.snapshot.resources.map((r) => [r.id, r]));
  function reserve(id: string, slot: Interval) {
    const capacity = resources.get(id)?.capacityId ?? id,
      booked = occupied.get(capacity) ?? [];
    booked.push(slot);
    occupied.set(capacity, booked);
  }
  for (const slot of input.protectedSlots ?? []) reserve(slot.resource, slot);
  for (const task of input.snapshot.tasks) {
    const slot =
      task.actual?.start && task.actual?.end
        ? { start: task.actual.start, end: task.actual.end }
        : (task.committed ?? task.forecast);
    if (slot)
      for (const id of task.resourceIds.length
        ? task.resourceIds
        : (task.forecastResourceIds ?? []))
        reserve(id, slot);
  }
  const opening = input.snapshot.activation !== "OBSERVE";
  const operations = input.routing.reduce(
    (m, r) => m.set(r.article_id, [...(m.get(r.article_id) ?? []), r]),
    new Map<string, RoutingStep[]>(),
  );
  const simulations = [];
  // Child proposals are emitted after their parent. Compute children first when they have the same date.
  const scoped = input.proposals
    .filter((p) => p.kind === "MAKE" && p.due <= input.through)
    .slice()
    .reverse()
    .sort((a, b) => a.due.localeCompare(b.due));
  const finishes = new Map<string, string>(),
    unsecured = new Set(
      input.proposals
        .filter((p) => p.kind !== "MAKE")
        .flatMap((p) => p.source_ids),
    );
  for (const p of scoped) {
    const blockers = [...p.issues];
    const alternatives: CapacityAlternative[] = [],
      placements: {
        phase: number;
        resource: string;
        start: string;
        end: string;
        minutes: number;
      }[] = [];
    if (!opening) blockers.push("Simulation atelier désactivée.");
    if (!p.release) blockers.push("Date de lancement non déterminée.");
    const steps = operations.get(p.article_id) ?? [];
    if (!steps.length) blockers.push("Aucune gamme applicable.");
    let earliest = Date.parse(
      (p.release && p.release > input.today ? p.release : input.today) +
        "T00:00:00Z",
    );
    for (const id of p.source_ids) {
      if (unsecured.has(id))
        blockers.push("Un composant proposé attend une confirmation.");
      const childEnd = finishes.get(id);
      if (childEnd) earliest = Math.max(earliest, Date.parse(childEnd));
    }
    const tentative = new Map(
      [...occupied.entries()].map(([k, v]) => [k, [...v]]),
    );
    for (const step of steps) {
      if (!opening || !p.release) break;
      if (step.kind === "SOUS_TRAITANCE") {
        blockers.push(step.label + " : promesse de traitement à obtenir.");
        break;
      }
      if (step.unit_minutes === null || step.setup_minutes === null) {
        blockers.push(step.label + " : temps de gamme manquant.");
        break;
      }
      const minutes = step.setup_minutes + step.unit_minutes * p.quantity;
      const eligible = step.resource_ids
        .map((id) => resources.get(id))
        .filter(
          (r): r is Resource =>
            !!r &&
            r.capacityEnabled !== false &&
            r.calendarConfigured !== false,
        );
      const slots = eligible
        .flatMap((r) => {
          const interval = capacitySlot([r], tentative, earliest, minutes);
          return interval && interval.end.slice(0, 10) <= input.through
            ? [{ r, interval }]
            : [];
        })
        .sort(
          (a, b) =>
            a.interval.end.localeCompare(b.interval.end) ||
            a.r.id.localeCompare(b.r.id),
        );
      const chosen = slots[0];
      if (!chosen) {
        blockers.push(
          step.label + " : aucun créneau qualifié sur six semaines.",
        );
        break;
      }
      const key = chosen.r.capacityId ?? chosen.r.id;
      tentative.set(key, [...(tentative.get(key) ?? []), chosen.interval]);
      placements.push({
        phase: step.phase,
        resource: chosen.r.id,
        ...chosen.interval,
        minutes,
      });
      for (const alt of slots.slice(1, 4))
        alternatives.push({
          operation_id: step.operation_id,
          resource: alt.r.id,
          end: alt.interval.end,
        });
      earliest = Date.parse(chosen.interval.end);
    }
    const complete = steps.length > 0 && placements.length === steps.length;
    const end = complete ? placements.at(-1)!.end : null;
    if (complete) for (const slot of placements) reserve(slot.resource, slot);
    if (
      end &&
      new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" }).format(
        new Date(end),
      ) > p.due
    )
      blockers.push("Fin calculée après la date demandée.");
    for (const id of p.source_ids) {
      if (!complete) unsecured.add(id);
      else finishes.set(id, end!);
    }
    simulations.push({
      article_id: p.article_id,
      article: p.article,
      source_ids: p.source_ids,
      requested: p.due,
      quantity: p.quantity,
      projected_finish: end,
      operations: placements,
      alternatives,
      blockers: [...new Set(blockers)],
      status: complete && !blockers.length ? "CAPACITY_SIMULATED" : "REVIEW",
    });
  }
  return simulations;
}
