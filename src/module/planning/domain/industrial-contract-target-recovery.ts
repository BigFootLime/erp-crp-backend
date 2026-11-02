import { createHash } from "node:crypto";
import { placeIndustrialProposals } from "./industrial-capacity";
import type { RecoveryCommitment } from "../repository/industrial-targets.repository";
import type {
  IndustrialContractTargetRecovery,
  IndustrialInput,
  IndustrialPlanTargetRecoverySource,
  IndustrialResult,
} from "../types/industrial-plan.types";

type Placement = {
  article_id: string;
  source_ids: string[];
  requested: string;
  projected_finish: string | null;
  blockers: string[];
  status: string;
  operations?: {start:string}[];
};

const plusDays = (day: string, days: number) =>
  new Date(Date.parse(day + "T12:00:00Z") + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const round = (value: number) =>
  Math.round((value + Number.EPSILON) * 1000) / 1000;

const parisDay = (instant: string) => new Intl.DateTimeFormat("sv-SE", {timeZone:"Europe/Paris"}).format(new Date(instant));

/** Compare the first slot available after the frozen period with the firm
 * date. Keep all other jobs, including the baseline simulation, in place. */
export function simulateRecoverySlots(
  source: IndustrialInput, result: IndustrialResult, prepared: readonly IndustrialPlanTargetRecoverySource[],
  baseline: ReturnType<typeof placeIndustrialProposals>,
  calendar: Pick<Parameters<typeof placeIndustrialProposals>[0], "snapshot" | "routing" | "through">,
) {
  if (!prepared.length) return [];
  const firms = new Map(source.demand.filter(d => d.kind === "FIRM").map(d => [d.id, d]));
  const supply = new Map(source.supplies.map(s => [s.id, s]));
  const fence = plusDays(source.today, source.frozenDays);
  const candidates = result.proposals.filter(p =>
    p.kind === "MAKE" && p.source_ids.length === 1 && firms.get(p.source_ids[0])?.article === p.article_id &&
    prepared.some(t => t.contract_line_id === p.contract_line_id && t.article_id === p.article_id && t.target_date <= p.due));
  const protectedSlots = baseline.filter(slot => !candidates.some(p =>
    p.article_id === slot.article_id && p.due === slot.requested && p.source_ids.includes(slot.source_ids[0])))
    .flatMap(slot => slot.operations);
  const proposals = candidates.map(p => {
    const id = p.source_ids[0];
    const issues = [...p.issues];
    let earliest = plusDays(fence, 1);
    for (const allocation of result.allocations.filter(a => a.demand_id.startsWith(id + "/"))) {
      const receipt = supply.get(allocation.source_id);
      if (!receipt) issues.push("Composant couvert par une proposition encore non engagée.");
      else if (receipt.available > earliest) earliest = receipt.available;
    }
    if (result.proposals.some(child => child.article_id !== p.article_id && child.source_ids.includes(id)))
      issues.push("Un achat, un traitement ou un OF de composant reste à confirmer.");
    const release = source.workdays.find(day => day >= earliest) ?? null;
    return {...p, release, issues};
  });
  return placeIndustrialProposals({...calendar,today:source.today,protectedSlots,proposals});
}

/**
 * Turns an already persisted contract preparation into an explainable
 * recovery suggestion. The net PDP owns the shortage, and the finite
 * placement owns the date. This function deliberately has no side effects.
 */
export function proposeIndustrialContractTargetRecovery(input: {
  source: IndustrialInput;
  result: IndustrialResult;
  prepared: readonly IndustrialPlanTargetRecoverySource[];
  placements: readonly Placement[];
  commitments?: readonly RecoveryCommitment[];
  transitDays?: number | null;
  capacityPercent?: number;
}): IndustrialContractTargetRecovery[] {
  const frozenUntil = plusDays(input.source.today, input.source.frozenDays);
  const demand = new Map(input.source.demand.map((item) => [item.id, item]));
  const supply = new Map(input.source.supplies.map((item) => [item.id, item]));
  const usedByDemand = new Map<string, { reserved: number; open: number }>();
  for (const allocation of input.result.allocations) {
    const item = supply.get(allocation.source_id);
    if (!item) continue;
    const used = usedByDemand.get(allocation.demand_id) ?? {
      reserved: 0,
      open: 0,
    };
    if (item.kind === "STOCK") used.reserved += allocation.quantity;
    if (item.kind === "OF" || item.kind === "OA")
      used.open += allocation.quantity;
    usedByDemand.set(allocation.demand_id, used);
  }

  const output: IndustrialContractTargetRecovery[] = [];
  const preparationByScope = new Map<
    string,
    IndustrialPlanTargetRecoverySource[]
  >();
  for (const prepared of input.prepared) {
    if (!prepared.target_overdue || prepared.proposed_quantity <= 0) continue;
    const key = `${prepared.contract_line_id}:${prepared.article_id}`;
    preparationByScope.set(key, [
      ...(preparationByScope.get(key) ?? []),
      prepared,
    ]);
  }
  for (const firm of input.source.demand.filter(
    (item) => item.kind === "FIRM",
  )) {
    const candidates = (
      preparationByScope.get(`${firm.contractLine}:${firm.article}`) ?? []
    )
      .filter((prepared) => prepared.target_date <= firm.due)
      .sort((left, right) => right.target_date.localeCompare(left.target_date));
    // One firm schedule is assigned to its closest relevant overdue target only.
    // Older monthly targets must never recreate the same shortage.
    const prepared = candidates[0];
    if (!prepared) continue;

    const matching = input.result.proposals.filter(
      (item) =>
        item.article_id === prepared.article_id &&
        item.contract_line_id === prepared.contract_line_id &&
        item.source_ids.includes(firm.id),
    );
    if (!matching.length) continue;
    const consumption = usedByDemand.get(firm.id) ?? { reserved: 0, open: 0 };
    const trueRemaining = round(
      Math.max(
        0,
        Number(firm.quantity) - consumption.reserved - consumption.open,
      ),
    );
    if (trueRemaining <= 0) continue;
    const plannedQuantity = round(
      matching.reduce((sum, item) => sum + item.quantity, 0),
    );
    const sourceIds = [firm.id];
    const needDate = firm.due;
    const candidate = input.placements
      .filter(
        (placement) =>
          placement.article_id === prepared.article_id &&
          placement.source_ids.includes(firm.id),
      )
      .sort((left, right) => left.requested.localeCompare(right.requested))[0];
    const risks = new Set<string>();
    if (!candidate)
      risks.add(
        "Simulation de capacité finie indisponible pour ce besoin ferme.",
      );
    if (candidate?.status !== "CAPACITY_SIMULATED")
      risks.add(
        "Capacité finie non démontrée sans impact sur les engagements existants.",
      );
    for (const blocker of candidate?.blockers ?? []) risks.add(blocker);
    for (const order of input.commitments ?? []) {
      if (order.article !== firm.article || (order.order_line && order.order_line !== firm.orderLine) ||
          (order.contract_line && order.contract_line !== firm.contractLine)) continue;
      const dated = input.source.supplies.some(s => (s.id===order.source || s.id.startsWith(order.source+":")) && s.available<=firm.due);
      if (!dated) risks.add(`Ordre ${order.reference} déjà ouvert : vérifier sa quantité et son échéance avant un autre lancement.`);
    }
    if (input.capacityPercent !== undefined && input.capacityPercent !== 100)
      risks.add("Le scénario modifie la capacité ordinaire : validation Production requise.");
    if (input.transitDays === null) risks.add("Délai de transport à confirmer pour tenir la date client.");
    if (matching.some((item) => !item.release || item.release <= frozenUntil))
      risks.add(
        "Le lancement requis tombe dans la fenêtre gelée ou ne possède pas de date de lancement sûre.",
      );
    if (plannedQuantity > trueRemaining)
      risks.add(
        "Le lot ou le rendement impose un surplus : arbitrage distinct requis.",
      );
    const finish = candidate?.projected_finish
      ? parisDay(candidate.projected_finish)
      : null;
    if (!finish || finish <= frozenUntil)
      risks.add("Aucun premier créneau sûr hors de la fenêtre gelée.");
    if (finish && finish > needDate)
      risks.add("Le premier créneau sûr dépasse la date ferme du client.");
    if (finish && input.transitDays != null && plusDays(finish, input.transitDays) > needDate)
      risks.add("La fin simulée et le transport dépassent la date ferme du client.");
    const status = risks.size === 0 ? "PROPOSED" : "ARBITRATION_REQUIRED";
    const evidence = {
      contract_line_id: prepared.contract_line_id,
      article_id: prepared.article_id,
      target_date: prepared.target_date,
      need_date: needDate,
      source_ids: sourceIds,
      trueRemaining,
      plannedQuantity,
      reserved: round(consumption.reserved),
      open: round(consumption.open),
      placement: candidate ?? null,
      frozenUntil,
      risks: [...risks].sort(),
      transitDays: input.transitDays ?? null,
    };
    output.push({
      proposal_id: createHash("sha256")
        .update(JSON.stringify(evidence))
        .digest("hex")
        .slice(0, 24),
      mode: "PROPOSAL_ONLY",
      contract_line_id: prepared.contract_line_id,
      article_id: prepared.article_id,
      article: prepared.article,
      unit: prepared.unit,
      target_month: prepared.month,
      target_date: prepared.target_date,
      need_date: needDate,
      quantity_needed: Number(firm.quantity),
      reserved_quantity: round(consumption.reserved),
      open_supply_quantity: round(consumption.open),
      proposed_quantity: trueRemaining,
      earliest_safe_date: status === "PROPOSED" ? finish : null,
      proposed_start_date: status === "PROPOSED" && candidate?.operations?.[0] ? parisDay(candidate.operations[0].start) : null,
      projected_finish_date: finish,
      estimated_receipt_date: finish && input.transitDays != null ? plusDays(finish, input.transitDays) : null,
      frozen_until: frozenUntil,
      status,
      risks: [...risks].sort(),
      freshness_digest: createHash("sha256")
        .update(JSON.stringify(evidence))
        .digest("hex"),
    });
  }
  return output.sort(
    (left, right) =>
      left.need_date.localeCompare(right.need_date) ||
      left.proposal_id.localeCompare(right.proposal_id),
  );
}
