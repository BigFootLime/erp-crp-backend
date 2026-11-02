import {
  CUMP_DECIMAL_SCALE as SCALE,
  formatCumpDecimal as fmt,
  parseCumpDecimal as qty,
} from "../../stock/domain/cump-decimal";
import type {
  IndustrialArticle,
  IndustrialCell,
  IndustrialDemand,
  IndustrialInput,
  IndustrialProposal,
  IndustrialResult,
  IndustrialSource,
} from "../types/industrial-plan.types";

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
const numeric = (a: bigint) => Number(fmt(a));
const plus = (day: string, n: number) =>
  new Date(Date.parse(day + "T12:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
const monday = (day: string) =>
  plus(day, -(new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7);
const monthOf = (day: string, n: number) =>
  new Date(
    Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1 + n, 1, 12),
  )
    .toISOString()
    .slice(0, 10);
const empty = (): IndustrialCell => ({
  historical_forecast: 0,
  firm: 0,
  forecast: 0,
  authorized_forecast: 0,
  internal: 0,
  planned: 0,
  shortage: 0,
  projected_stock: 0,
  revenue_eur: 0,
});
type Need = IndustrialDemand & { origins: string[]; dependent?: boolean };
type Supply = IndustrialSource & { remaining: bigint };
type Event = {
  day: string;
  opening?: bigint;
  firm?: bigint;
  forecast?: bigint;
  historical?: bigint;
  approved?: bigint;
  internal?: bigint;
  planned?: bigint;
  shortage?: bigint;
  consumption?: bigint;
  revenue?: bigint | null;
};
function parentFirst(input: IndustrialInput) {
  const nodes = new Map(input.articles.map((a) => [a.id, a]));
  const parents = new Map(input.articles.map((a) => [a.id, 0]));
  const children = new Map<string, typeof input.bom>();
  for (const edge of input.bom) {
    if (
      !nodes.has(edge.parent) ||
      !nodes.has(edge.child) ||
      qty(edge.factor) <= 0n
    )
      throw new Error("Nomenclature incomplète ou coefficient invalide.");
    parents.set(edge.child, parents.get(edge.child)! + 1);
    children.set(edge.parent, [...(children.get(edge.parent) ?? []), edge]);
  }
  const queue = [...nodes.keys()].filter((k) => parents.get(k) === 0).sort();
  for (let i = 0; i < queue.length; i++)
    for (const edge of children.get(queue[i]) ?? []) {
      const count = parents.get(edge.child)! - 1;
      parents.set(edge.child, count);
      if (!count) queue.push(edge.child);
    }
  if (queue.length !== nodes.size)
    throw new Error("Cycle dans la nomenclature applicable.");
  return { sequence: queue.map((k) => nodes.get(k)!), children };
}
function eligible(source: Supply, need: Need) {
  return (
    source.article === need.article &&
    source.unit === need.unit &&
    source.available <= need.due &&
    (!source.contractLine || source.contractLine === need.contractLine) &&
    (!source.orderLine || source.orderLine === need.orderLine) &&
    (!source.allocation || source.allocation === need.allocation)
  );
}
function releaseDay(workdays: string[], due: string, lead: number | null) {
  if (lead === null) return null;
  const eligible = workdays.filter((d) => d <= due);
  return eligible.at(-(lead + 1)) ?? null;
}
function aggregate(events: Event[], bounds: string[], end: string) {
  let balance = 0n;
  return bounds.map((date, i) => {
    const until = bounds[i + 1] ?? end;
    const rows = events.filter(
      (e) => e.day < until && (i === 0 || e.day >= date),
    );
    const cell = empty();
    let revenue: bigint | null = 0n;
    for (const row of rows) {
      cell.firm += numeric(row.firm ?? 0n);
      cell.forecast += numeric(row.forecast ?? 0n);
      cell.historical_forecast += numeric(row.historical ?? 0n);
      cell.internal += numeric(row.internal ?? 0n);
      cell.authorized_forecast += numeric(row.approved ?? 0n);
      cell.planned += numeric(row.planned ?? 0n);
      cell.shortage += numeric(row.shortage ?? 0n);
      balance +=
        (row.opening ?? 0n) + (row.planned ?? 0n) - (row.consumption ?? 0n);
      if (row.revenue === null) revenue = null;
      else if (revenue !== null) revenue += row.revenue ?? 0n;
    }
    cell.projected_stock = numeric(balance);
    cell.revenue_eur = revenue === null ? null : numeric(revenue);
    return cell;
  });
}
export function calculateIndustrialPlan(
  input: IndustrialInput,
): IndustrialResult {
  const { sequence, children } = parentFirst(input),
    issues = new Set(input.issues);
  const proposals: IndustrialProposal[] = [],
    allocations: IndustrialResult["allocations"] = [];
  const weeks = Array.from({ length: input.weeks }, (_, i) =>
    plus(monday(input.start), 7 * i),
  );
  const months = Array.from({ length: input.months }, (_, i) =>
    monthOf(input.start, i),
  );
  const end = monthOf(input.start, input.months),
    freeze = plus(input.today, input.frozenDays);
  const rules = new Map(input.rules.map((r) => [r.id, r]));
  const globalCap = input.clientRisk === null ? null : qty(input.clientRisk);
  let exposure =
    input.openingExposure === null ? null : qty(input.openingExposure);
  const riskByLine = new Map<string, bigint>();
  const needs = new Map<string, Need[]>(),
    ledger = new Map<string, Supply[]>();
  const ids = new Set<string>();
  const events = new Map<string, Event[]>();
  const addNeed = (n: Need) => {
    const list = needs.get(n.article) ?? [];
    list.push(n);
    needs.set(n.article, list);
  };
  const addEvent = (id: string, e: Event) => {
    const list = events.get(id) ?? [];
    list.push(e);
    events.set(id, list);
  };
  for (const d of input.demand) {
    if (ids.has(d.id)) throw new Error("Échéance dupliquée.");
    ids.add(d.id);
    if (d.due < end) addNeed({ ...d, origins: [d.id] });
  }
  ids.clear();
  for (const s of input.supplies) {
    if (ids.has(s.id)) throw new Error("Source de stock dupliquée.");
    ids.add(s.id);
    const list = ledger.get(s.article) ?? [];
    list.push({ ...s, remaining: qty(s.quantity) });
    ledger.set(s.article, list);
    addEvent(s.article, { day: s.available, opening: qty(s.quantity) });
  }
  // Reserve an existing physical slice. Splitting the quantity preserves a single ledger across all contracts.
  for (const r of [...input.rules].sort((a, b) => a.id.localeCompare(b.id))) {
    let protect = qty(r.reserve);
    const sources = ledger.get(r.article) ?? [];
    for (const s of [...sources]) {
      if (!protect) break;
      if (s.kind !== "STOCK" || s.contractLine || s.orderLine || s.allocation)
        continue;
      const take = min(s.remaining, protect);
      if (!take) continue;
      s.remaining -= take;
      s.quantity = fmt(s.remaining);
      protect -= take;
      sources.push({
        ...s,
        id: s.id + ":" + r.id,
        remaining: take,
        quantity: fmt(take),
        contractLine: r.id,
      });
    }
    if (protect > 0n)
      issues.add(
        "Réserve sous le minimum pour la ligne de contrat " + r.id + ".",
      );
  }
  for (const article of sequence) {
    const entries = needs.get(article.id) ?? [];
    const sources = ledger.get(article.id) ?? [];
    const candidates = entries.sort(
      (a, b) =>
        Number(!!b.buildForStock) - Number(!!a.buildForStock) ||
        Number(a.kind === "FORECAST") - Number(b.kind === "FORECAST") ||
        a.due.localeCompare(b.due) ||
        a.id.localeCompare(b.id),
    );
    const balances = new Map<string | null, Map<string, bigint>>();
    const movement = (owner: string | null, date: string, delta: bigint) => {
      const days = balances.get(owner) ?? new Map<string, bigint>();
      days.set(date, (days.get(date) ?? 0n) + delta);
      balances.set(owner, days);
    };
    for (const s of sources)
      if (!s.orderLine && !s.allocation)
        movement(s.contractLine, s.available, qty(s.quantity));
    const process = (n: Need, target = false) => {
      const gross = qty(n.quantity),
        due = n.due < input.today ? input.today : n.due;
      if (n.unit !== article.unit) {
        issues.add("Unité incompatible pour " + n.id + ".");
        return;
      }
      const available =
        target || n.buildForStock
          ? []
          : sources
              .filter((s) => eligible(s, { ...n, due }))
              .sort(
                (a, b) =>
                  Number(!!b.orderLine) +
                    Number(!!b.contractLine) -
                    Number(!!a.orderLine) -
                    Number(!!a.contractLine) ||
                  a.available.localeCompare(b.available) ||
                  a.id.localeCompare(b.id),
              );
      const cover = available.reduce((v, s) => v + s.remaining, 0n);
      let approved = gross;
      const rule = n.contractLine ? rules.get(n.contractLine) : undefined;
      if (n.kind === "FORECAST" && (n.historical || !rule?.forecastCommitted)) {
        const cost = article.cost === null ? 0n : qty(article.cost);
        const budget =
          rule?.clientId === input.clientId &&
          exposure !== null &&
          globalCap !== null &&
          rule.riskEur !== null &&
          cost > 0n
            ? min(
                max(0n, globalCap - exposure),
                max(0n, qty(rule.riskEur) - qty(input.openingExposure!) - (riskByLine.get(rule.id) ?? 0n)),
              )
            : 0n;
        const extra = cost > 0n ? (budget * SCALE) / cost : 0n;
        approved = min(gross, cover + extra);
        const extraQty = max(0n, approved - cover);
        // Charge the complete lot, including yield loss. A lot that cannot fit is not authorised.
        const lot = article.lot ? qty(article.lot) : 0n;
        const starts = ceil(extraQty * 100n * SCALE, qty(article.yieldPercent));
        const launch = lot ? ceil(starts, lot) * lot : starts;
        const value = ceil(launch * cost, SCALE);
        if (value > budget) approved = min(gross, cover);
        else if (exposure !== null && rule) {
          exposure += value;
          riskByLine.set(rule.id, (riskByLine.get(rule.id) ?? 0n) + value);
        }
        if (approved < gross)
          issues.add("Prévision hors enveloppe : " + n.id + ".");
      }
      if (!target)
        addEvent(article.id, {
          day: n.due,
          firm: n.kind === "FIRM" && !n.dependent ? gross : 0n,
          forecast: n.kind === "FORECAST" && !n.historical ? gross : 0n,
          historical: n.historical ? gross : 0n,
          approved: n.kind === "FORECAST" ? approved : 0n,
          internal: n.kind === "INTERNAL" && !n.dependent ? gross : 0n,
          consumption: n.buildForStock ? 0n : approved,
          revenue:
            n.kind === "FIRM" && !n.dependent
              ? n.priceEur === null
                ? null
                : (gross * qty(n.priceEur)) / SCALE
              : 0n,
          shortage: gross - approved,
        });
      let missing = approved;
      for (const s of available) {
        const take = min(missing, s.remaining);
        if (!take) continue;
        if (!target) {
          s.remaining -= take;
          allocations.push({
            demand_id: n.id,
            source_id: s.id,
            quantity: numeric(take),
          });
          if (!s.orderLine && !s.allocation)
            movement(s.contractLine, due, -take);
        }
        missing -= take;
      }
      if (!missing) return;
      const yieldRatio = qty(article.yieldPercent);
      if (yieldRatio === 0n || yieldRatio > 100n * SCALE)
        throw new Error("Rendement article invalide.");
      const starts = ceil(missing * 100n * SCALE, yieldRatio);
      const lot = article.lot ? qty(article.lot) : 0n,
        launch = lot ? ceil(starts, lot) * lot : starts;
      const good = (launch * yieldRatio) / (100n * SCALE);
      const release = releaseDay(input.workdays, due, article.leadDays);
      const blockers = [...article.technicalIssues];
      if (target)
        blockers.push(
          "Objectif de stock : contrôler l’exposition avant tout lancement.",
        );
      if (!release) blockers.push("Délai ou calendrier de lancement manquant.");
      if (release && release < freeze)
        blockers.push("Lancement en zone protégée ou en retard.");
      proposals.push({
        article_id: article.id,
        article: article.code,
        unit: article.unit,
        kind: article.kind,
        quantity: numeric(launch),
        due,
        release,
        source_ids: n.origins,
        issues: blockers,
        contract_line_id: n.contractLine,
      });
      blockers.forEach((b) => issues.add(article.code + " : " + b));
      addEvent(article.id, { day: due, planned: good });
      const surplus = target || n.buildForStock ? good : good - missing;
      if (surplus) {
        sources.push({
          id: "planned:" + n.id,
          article: article.id,
          unit: article.unit,
          available: due,
          quantity: fmt(surplus),
          remaining: surplus,
          orderLine: null,
          allocation: null,
          contractLine: n.contractLine,
          kind: "OF",
        });
        movement(n.contractLine, due, surplus);
      }
      if (article.kind === "MAKE" && release)
        for (const [index, edge] of (
          children.get(article.id) ?? []
        ).entries()) {
          const child = articleById.get(edge.child)!;
          addNeed({
            id: n.id + "/" + index,
            article: child.id,
            unit: child.unit,
            contractLine: null,
            orderLine: null,
            allocation: null,
            kind: "INTERNAL",
            dependent: true,
            quantity: fmt(ceil(launch * qty(edge.factor), SCALE)),
            due: release,
            origins: n.origins,
            priceEur: null,
          });
        }
    };
    const articleById = new Map(sequence.map((a) => [a.id, a]));
    for (const n of candidates) process(n);
    // A target is a balance requirement, not a second customer demand.
    const replenish = (
      line: string | null,
      minimum: string,
      targetQty: string,
    ) => {
      if (!qty(minimum)) return;
      const days = balances.get(line) ?? new Map<string, bigint>();
      const timeline = [
        ...new Set(
          [input.today, ...days.keys()].map((d) =>
            d < input.today ? input.today : d,
          ),
        ),
      ]
        .filter((d) => d < end)
        .sort();
      let balance = 0n;
      for (const date of timeline) {
        balance +=
          date === input.today
            ? [...days]
                .filter(([d]) => d <= date)
                .reduce((v, [, q]) => v + q, 0n)
            : (days.get(date) ?? 0n);
        if (balance >= qty(minimum)) continue;
        const id =
          "target:" + article.id + ":" + (line ?? "general") + ":" + date;
        const before = balances.get(line)?.get(date) ?? 0n;
        process(
          {
            id,
            article: article.id,
            unit: article.unit,
            contractLine: line,
            orderLine: null,
            allocation: null,
            kind: "INTERNAL",
            quantity: fmt(qty(targetQty) - balance),
            due: date,
            priceEur: null,
            origins: [id],
          },
          true,
        );
        balance += (balances.get(line)?.get(date) ?? 0n) - before;
      }
    };
    replenish(null, article.minStock, article.targetStock);
    for (const r of input.rules.filter((r) => r.article === article.id))
      replenish(r.id, r.reserve, r.target);
  }
  const pdp: IndustrialResult["pdp"] = [],
    picMap = new Map<string, IndustrialResult["pic"][number]>();
  for (const article of sequence) {
    const rows = events.get(article.id) ?? [];
    if (!rows.length) continue;
    aggregate(rows, weeks, plus(weeks.at(-1)!, 7)).forEach((cell, i) =>
      pdp.push({
        ...cell,
        week: weeks[i],
        article_id: article.id,
        article: article.code,
        unit: article.unit,
      }),
    );
    aggregate(rows, months, end).forEach((cell, i) => {
      const key = JSON.stringify([months[i], article.family, article.unit]);
      const item = picMap.get(key) ?? {
        ...empty(),
        month: months[i],
        family: article.family,
        unit: article.unit,
      };
      for (const prop of [
        "firm",
        "forecast",
        "historical_forecast",
        "authorized_forecast",
        "planned",
        "shortage",
        "projected_stock",
        "internal",
      ] as const)
        item[prop] += cell[prop];
      item.revenue_eur =
        cell.revenue_eur === null || item.revenue_eur === null
          ? null
          : item.revenue_eur + cell.revenue_eur;
      picMap.set(key, item);
    });
  }
  return {
    pic: [...picMap.values()],
    pdp,
    proposals,
    allocations,
    issues: [...issues].sort(),
    forecast_exposure_eur: exposure === null ? null : numeric(exposure),
  };
}
