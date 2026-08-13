export const STOCK_INTELLIGENCE_CONTRACT_VERSION = "CERP-STOCK-INTELLIGENCE-1.0.0";
export const STOCK_INTELLIGENCE_TIMEZONE = "Europe/Paris";

export type StockReliability = "ESTIMATED" | "PARTIAL" | "ACTUAL" | "UNAVAILABLE";

export type StockIntelligencePolicy = {
  id: string | null;
  valid_from: string;
  abc_lookback_days: number;
  abc_a_cumulative_pct: number;
  abc_b_cumulative_pct: number;
  dormant_after_days: number;
  consumption_lookback_days: number;
  coverage_weeks: number;
  inventory_tolerance_pct: number;
  inventory_absolute_tolerance_qty: number;
  source: "VERSIONED_POLICY" | "SYSTEM_DEFAULT";
};

export const STOCK_INTELLIGENCE_DEFAULT_POLICY: StockIntelligencePolicy = {
  id: null,
  valid_from: "2026-08-13",
  abc_lookback_days: 365,
  abc_a_cumulative_pct: 80,
  abc_b_cumulative_pct: 95,
  dormant_after_days: 180,
  consumption_lookback_days: 91,
  coverage_weeks: 13,
  inventory_tolerance_pct: 0.5,
  inventory_absolute_tolerance_qty: 0.001,
  source: "SYSTEM_DEFAULT",
};

export type DatedQuantity = {
  date: string;
  quantity: number;
  source: string;
  reference: string | null;
};

export type ProjectionPoint = {
  week: number;
  from: string;
  to: string;
  demand_qty: number;
  expected_receipt_qty: number;
  simulated_receipt_qty: number;
  stock_without_proposal: number | null;
  stock_with_proposal: number | null;
  reliability: StockReliability;
  causes: string[];
};

export type StockProjection = {
  points: ProjectionPoint[];
  shortage_without_proposal: string | null;
  shortage_with_proposal: string | null;
  missing: string[];
  assumptions: string[];
};

const DAY_MS = 86_400_000;

function parseDateOnly(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function roundStockQty(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

export function roundStockMetric(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function validNonNegative(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeEvents(events: readonly DatedQuantity[], missing: Set<string>, missingCode: string) {
  return events
    .flatMap((event) => {
      const at = parseDateOnly(event.date);
      if (at === null || !validNonNegative(event.quantity)) {
        missing.add(missingCode);
        return [];
      }
      return [{ ...event, at, quantity: roundStockQty(event.quantity) }];
    })
    .sort((left, right) => left.at - right.at || left.source.localeCompare(right.source));
}

/**
 * Rolling seven-day projection. The initial quantity is usable physical stock
 * before future dated reservations: quarantine, blocked and depreciated stock
 * must already have been excluded by the repository.
 */
export function buildStockProjection(input: {
  as_of: string;
  weeks: number;
  initial_usable_qty: number | null;
  demands: readonly DatedQuantity[];
  receipts: readonly DatedQuantity[];
  simulated_receipt?: DatedQuantity | null;
  missing?: readonly string[];
}): StockProjection {
  const start = parseDateOnly(input.as_of);
  if (start === null) throw new Error("as_of must be a valid YYYY-MM-DD date");
  if (!Number.isInteger(input.weeks) || input.weeks < 1 || input.weeks > 13) {
    throw new Error("weeks must be an integer between 1 and 13");
  }

  const missing = new Set(input.missing ?? []);
  if (!validNonNegative(input.initial_usable_qty)) missing.add("STARTING_USABLE_STOCK");
  const demands = normalizeEvents(input.demands, missing, "DEMAND_QUANTITY_OR_DATE");
  const receipts = normalizeEvents(input.receipts, missing, "RECEIPT_QUANTITY_OR_DATE");
  const simulated = input.simulated_receipt
    ? normalizeEvents([input.simulated_receipt], missing, "SIMULATION_QUANTITY_OR_DATE")
    : [];
  const horizonEnd = start + input.weeks * 7 * DAY_MS;

  for (const event of demands) {
    if (event.at < start) {
      event.at = start;
      event.date = input.as_of;
      missing.add("PAST_DUE_DEMAND");
    } else if (event.at >= horizonEnd) missing.add("EVENT_OUTSIDE_HORIZON");
  }
  for (const event of receipts) {
    if (event.at < start) {
      event.at = start;
      event.date = input.as_of;
      missing.add("PAST_DUE_RECEIPT");
    } else if (event.at >= horizonEnd) missing.add("EVENT_OUTSIDE_HORIZON");
  }
  for (const event of simulated) {
    if (event.at < start) {
      event.at = start;
      event.date = input.as_of;
      missing.add("PAST_DUE_SIMULATION");
    } else if (event.at >= horizonEnd) missing.add("EVENT_OUTSIDE_HORIZON");
  }

  let withoutProposal = validNonNegative(input.initial_usable_qty) ? input.initial_usable_qty : null;
  let withProposal = withoutProposal;
  let shortageWithout: string | null = null;
  let shortageWith: string | null = null;
  const points: ProjectionPoint[] = [];

  for (let index = 0; index < input.weeks; index += 1) {
    const from = start + index * 7 * DAY_MS;
    const toExclusive = from + 7 * DAY_MS;
    const weekDemands = demands.filter((event) => event.at >= from && event.at < toExclusive);
    const weekReceipts = receipts.filter((event) => event.at >= from && event.at < toExclusive);
    const weekSimulated = simulated.filter((event) => event.at >= from && event.at < toExclusive);
    const demandQty = roundStockQty(weekDemands.reduce((sum, event) => sum + event.quantity, 0));
    const receiptQty = roundStockQty(weekReceipts.reduce((sum, event) => sum + event.quantity, 0));
    const simulatedQty = roundStockQty(weekSimulated.reduce((sum, event) => sum + event.quantity, 0));

    const chronological = [
      ...weekReceipts.map((event) => ({ ...event, kind: "receipt" as const })),
      ...weekSimulated.map((event) => ({ ...event, kind: "simulated" as const })),
      ...weekDemands.map((event) => ({ ...event, kind: "demand" as const })),
    ].sort((left, right) => left.at - right.at || left.kind.localeCompare(right.kind));

    for (const event of chronological) {
      if (withoutProposal !== null && event.kind !== "simulated") {
        withoutProposal = roundStockQty(withoutProposal + (event.kind === "receipt" ? event.quantity : -event.quantity));
        if (withoutProposal < 0 && shortageWithout === null) shortageWithout = dateOnly(event.at);
      }
      if (withProposal !== null) {
        withProposal = roundStockQty(withProposal + (event.kind === "demand" ? -event.quantity : event.quantity));
        if (withProposal < 0 && shortageWith === null) shortageWith = dateOnly(event.at);
      }
    }

    const causes = [...new Set([...weekDemands, ...weekReceipts, ...weekSimulated].map((event) => event.source))].sort();
    points.push({
      week: index + 1,
      from: dateOnly(from),
      to: dateOnly(toExclusive - DAY_MS),
      demand_qty: demandQty,
      expected_receipt_qty: receiptQty,
      simulated_receipt_qty: simulatedQty,
      stock_without_proposal: withoutProposal,
      stock_with_proposal: withProposal,
      reliability: withoutProposal === null
        ? "UNAVAILABLE"
        : missing.size > 0
          ? "PARTIAL"
          : "ACTUAL",
      causes,
    });
  }

  return {
    points,
    shortage_without_proposal: shortageWithout,
    shortage_with_proposal: shortageWith,
    missing: [...missing].sort(),
    assumptions: [
      "Horizon glissant en tranches de 7 jours à partir de la date d'observation.",
      "Seuls les besoins OF réservés et les réservations actives datables sont soustraits.",
      "Seules les commandes fournisseurs fermes, non annulées, convertibles et datées sont ajoutées.",
      "La proposition simulée est une hypothèse en mémoire et ne crée aucun mouvement ni achat.",
    ],
  };
}

export type AbcInput = { key: string; consumption_value: number | null };
export type AbcResult = { key: string; classification: "A" | "B" | "C" | null; cumulative_pct: number | null };

export function classifyAbc(
  inputs: readonly AbcInput[],
  aCumulativePct: number,
  bCumulativePct: number,
): AbcResult[] {
  if (!(aCumulativePct > 0 && aCumulativePct < bCumulativePct && bCumulativePct <= 100)) {
    throw new Error("ABC thresholds must satisfy 0 < A < B <= 100");
  }
  const valid = inputs.filter(
    (item): item is { key: string; consumption_value: number } => validNonNegative(item.consumption_value),
  );
  const total = valid.reduce((sum, item) => sum + item.consumption_value, 0);
  if (total <= 0) {
    return inputs.map((item) => ({ key: item.key, classification: null, cumulative_pct: null }));
  }
  const sorted = [...valid].sort((left, right) =>
    right.consumption_value - left.consumption_value || left.key.localeCompare(right.key));
  let running = 0;
  const classified = new Map<string, AbcResult>();
  for (const item of sorted) {
    const before = (running / total) * 100;
    running += item.consumption_value;
    const cumulative = roundStockMetric((running / total) * 100, 4);
    classified.set(item.key, {
      key: item.key,
      classification: before < aCumulativePct ? "A" : before < bCumulativePct ? "B" : "C",
      cumulative_pct: cumulative,
    });
  }
  return inputs.map((item) => classified.get(item.key) ?? {
    key: item.key,
    classification: null,
    cumulative_pct: null,
  });
}

export function stockTurnoverPerYear(input: {
  outbound_qty: number | null;
  current_usable_qty: number | null;
  lookback_days: number;
}): number | null {
  if (!validNonNegative(input.outbound_qty) || !validNonNegative(input.current_usable_qty)) return null;
  if (!Number.isFinite(input.lookback_days) || input.lookback_days <= 0 || input.current_usable_qty <= 0) return null;
  return roundStockMetric((input.outbound_qty * 365 / input.lookback_days) / input.current_usable_qty, 2);
}

export function historicalCoverageWeeks(input: {
  current_available_qty: number | null;
  consumed_qty: number | null;
  lookback_days: number;
}): number | null {
  if (!validNonNegative(input.current_available_qty) || !validNonNegative(input.consumed_qty)) return null;
  if (!Number.isFinite(input.lookback_days) || input.lookback_days <= 0) return null;
  const weekly = input.consumed_qty / (input.lookback_days / 7);
  if (weekly <= 0) return null;
  return roundStockMetric(input.current_available_qty / weekly, 2);
}

export function inventoryAccuracy(input: {
  lines: ReadonlyArray<{ theoretical_qty: number | null; counted_qty: number | null }>;
  tolerance_pct: number;
  absolute_tolerance_qty: number;
}): { value: number | null; exact_lines: number; counted_lines: number; missing_lines: number } {
  let exact = 0;
  let counted = 0;
  let missing = 0;
  for (const line of input.lines) {
    if (!validNonNegative(line.theoretical_qty) || !validNonNegative(line.counted_qty)) {
      missing += 1;
      continue;
    }
    counted += 1;
    const tolerance = Math.max(
      input.absolute_tolerance_qty,
      line.theoretical_qty * input.tolerance_pct / 100,
    );
    if (Math.abs(line.counted_qty - line.theoretical_qty) <= tolerance + 1e-9) exact += 1;
  }
  return {
    value: counted > 0 ? roundStockMetric(exact / counted * 100, 2) : null,
    exact_lines: exact,
    counted_lines: counted,
    missing_lines: missing,
  };
}

export function summarizeStockValues(
  inputs: ReadonlyArray<{ value: number | null; currency: string }>,
): { value: number | null; unit: string; reliability: StockReliability; missing: string[] } {
  const known = inputs.filter((item): item is { value: number; currency: string } =>
    typeof item.value === "number" && Number.isFinite(item.value));
  if (known.length === 0) {
    return { value: null, unit: "devise", reliability: "UNAVAILABLE", missing: ["UNVALUED_STOCK_SCOPES"] };
  }
  const currencies = [...new Set(known.map((item) => item.currency))];
  if (currencies.length !== 1) {
    return { value: null, unit: "devises multiples", reliability: "UNAVAILABLE", missing: ["STOCK_VALUE_CURRENCY_CONFLICT"] };
  }
  return {
    value: roundStockMetric(known.reduce((sum, item) => sum + item.value, 0), 2),
    unit: currencies[0],
    reliability: known.length === inputs.length ? "ESTIMATED" : "PARTIAL",
    missing: known.length === inputs.length ? ["COST_LAYER_NOT_MATERIALIZED"] : ["UNVALUED_STOCK_SCOPES"],
  };
}
