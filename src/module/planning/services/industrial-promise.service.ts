import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { readContractCoverageStock } from "../../client/repository/client-contract-coverage-stock.repository";
import {
  CONTRACT_COVERAGE_CADRE_REVIEW_SQL,
  CONTRACT_COVERAGE_FIRM_SQL,
  type FirmCoverageRow,
} from "../../client/repository/client-contract-coverage.repository";
import {
  formatCumpDecimal,
  parseCumpDecimal,
} from "../../stock/domain/cump-decimal";
import { readIndustrialRules } from "../repository/industrial-input.repository";

export type DemandStockCheck = {
  clientId: string;
  articleId: string;
  contractId: string | null;
  quantity: string | number;
  unit: string;
  needDate: string;
  now?: string;
  orderLineId?: string | null;
  allocationId?: string | null;
};
export async function assessDemandStock(
  db: Pick<PoolClient, "query">,
  input: DemandStockCheck,
) {
  const blockers: string[] = [];
  const unit = input.unit.trim().toUpperCase(),
    qty = parseCumpDecimal(String(input.quantity));
  // Serialize book decisions even on articles with no stock row yet. Executable reservations still use the stock module.
  const article = (
    await db.query<{ unit: string; root: string }>(
      `SELECT upper(btrim(unite)) AS unit,COALESCE(root_article_id,id)::text AS root
 FROM public.articles WHERE id=$1 AND archived_at IS NULL AND status='VALIDE' FOR UPDATE`,
      [input.articleId],
    )
  ).rows[0];
  if (!article || article.unit !== unit || qty <= 0n)
    blockers.push("Article, quantité ou unité non valide.");
  await db.query(
    "SELECT id FROM public.stock_levels WHERE article_id=$1 ORDER BY id FOR UPDATE",
    [input.articleId],
  );
  const scope = await db.query(
    "SELECT 1 FROM public.article_client_links WHERE article_id=$1 AND client_id=$2",
    [input.articleId, input.clientId],
  );
  if (!scope.rowCount) blockers.push("Référence client non qualifiée.");
  const { sources, issues } = await readContractCoverageStock(db, [
    input.articleId,
  ]);
  const owned = (
    await db.query<{ id: string }>(
      `SELECT id::text FROM public.lots WHERE article_id::text=$1 AND client_proprietaire_id IS NOT NULL`,
      [input.articleId],
    )
  ).rows;
  const excluded = new Set(owned.map((r) => r.id));
  let free = sources
    .filter(
      (s) =>
        s.kind === "FREE" && s.unit === unit && !excluded.has(s.reference_id),
    )
    .reduce((t, s) => t + parseCumpDecimal(s.quantity), 0n);
  const firm = (
    await db.query<FirmCoverageRow>(CONTRACT_COVERAGE_FIRM_SQL, [
      [input.articleId],
    ])
  ).rows;
  if (firm.length > 2000)
    blockers.push("Carnet trop volumineux pour une décision automatique.");
  const legacy = (
    await db.query<{ needs_review: boolean }>(
      CONTRACT_COVERAGE_CADRE_REVIEW_SQL,
      [[input.articleId]],
    )
  ).rows[0];
  if (legacy.needs_review)
    blockers.push("Appel historique sans rapprochement.");
  const rules = await readIndustrialRules(db, [input.articleId]);
  const balances = new Map(
    rules.map((r) => [r.id, parseCumpDecimal(r.reserve)]),
  );
  const eligible = new Set(
    (
      await db.query<{ id: string }>(
        `SELECT l.id FROM public.client_contract_lines l JOIN public.client_contracts c ON c.id=l.contract_id
 WHERE c.id=$1::uuid AND c.client_id=$2 AND c.status='ACTIVE' AND l.active AND l.root_article_id=$3::uuid`,
        [input.contractId, input.clientId, article?.root ?? input.articleId],
      )
    ).rows.map((x) => x.id),
  );
  if (input.contractId && !eligible.size)
    blockers.push("Contrat ou article hors périmètre.");
  for (const line of firm) {
    if (line.legacy_shipment || line.unit !== unit) {
      blockers.push("Livraison historique ou unité à rapprocher.");
      continue;
    }
    const remaining =
      parseCumpDecimal(line.quantity) - parseCumpDecimal(line.delivered);
    if (remaining < 0n) {
      blockers.push("Quantité livrée supérieure à la quantité commandée.");
      continue;
    }
    let existingRemaining = remaining;
    if (input.orderLineId === line.id && input.allocationId) {
      const own = line.allocations.find((a) => a.id === input.allocationId);
      if (own)
        existingRemaining -=
          parseCumpDecimal(own.quantity) - parseCumpDecimal(own.delivered);
      else blockers.push("Affectation de livraison à rapprocher.");
    }
    const reserved = sources
      .filter(
        (s) =>
          s.order_line_id === line.id &&
          s.unit === unit &&
          (!input.allocationId || s.allocation_id !== input.allocationId),
      )
      .reduce((t, s) => t + parseCumpDecimal(s.quantity), 0n);
    const required =
      existingRemaining > reserved ? existingRemaining - reserved : 0n;
    free -= required;
    if (line.contract_line_id && balances.has(line.contract_line_id)) {
      const rest = balances.get(line.contract_line_id)! - required;
      balances.set(line.contract_line_id, rest > 0n ? rest : 0n);
    }
  }
  for (const [lineId, balance] of balances)
    if (!eligible.has(lineId)) free -= balance;
  if (input.orderLineId) {
    const reserved = sources
      .filter(
        (s) =>
          s.order_line_id === input.orderLineId &&
          s.allocation_id === input.allocationId &&
          s.unit === unit,
      )
      .reduce((t, s) => t + parseCumpDecimal(s.quantity), 0n);
    free += reserved;
  }
  const date = (
    await db.query<{
      today: string;
      transit: number | null;
      dispatch: string | null;
    }>(
      `SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS today,p.transit_calendar_days AS transit,
  (SELECT max(day)::date::text FROM public.planning_central_settings s JOIN public.programmation_calendars c ON c.id=s.workshop_calendar_id AND c.active
   CROSS JOIN generate_series((now() AT TIME ZONE 'Europe/Paris')::date,$1::date-p.transit_calendar_days,interval '1 day') AS day
   WHERE s.singleton AND extract(isodow FROM day)::smallint=ANY(c.working_days)
   AND NOT EXISTS(SELECT 1 FROM public.programmation_calendar_closures x WHERE x.calendar_id=c.id AND day::date BETWEEN x.start_date AND x.end_date)) AS dispatch
 FROM (SELECT $2::text AS id) client LEFT JOIN public.industrial_policies p ON p.client_id=client.id`,
      [input.needDate, input.clientId],
    )
  ).rows[0];
  if (date.transit === null)
    blockers.push(
      "Délai de préparation et de transport à qualifier pour ce client.",
    );
  else if (!date.dispatch)
    blockers.push(
      "Aucun départ atelier compatible avec la date de réception demandée.",
    );
  if (free < qty)
    blockers.push(
      "Stock libre insuffisant après protection des autres promesses.",
    );
  const available = free > 0n ? free : 0n;
  const evidence = {
    article: input.articleId,
    client: input.clientId,
    contract: input.contractId,
    unit,
    quantity: formatCumpDecimal(qty),
    due: input.needDate,
    stock: sources.map((s) => [s.id, s.quantity]),
    firm: firm.map((f) => [f.id, f.quantity, f.delivered]),
    balances: [...balances],
    available: formatCumpDecimal(available),
    blockers,
  };
  const hash = createHash("sha256")
    .update(
      JSON.stringify(evidence, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    )
    .digest("hex");
  const proven = blockers.length === 0;
  return {
    scenario_code: proven
      ? "PHYSICAL_STOCK"
      : available > 0n
        ? "PARTIAL_STOCK"
        : "CAPACITY_REVIEW",
    input_revision: hash,
    capacity_state: proven ? ("PROVEN" as const) : ("UNKNOWN" as const),
    cost_state: proven ? ("PROVEN" as const) : ("UNKNOWN" as const),
    feasible_need_date: proven ? input.needDate : null,
    latest_dispatch: date.dispatch,
    blockers: [...new Set(blockers)],
    available_quantity: formatCumpDecimal(available),
    options: proven
      ? ["SERVE_STOCK"]
      : available > 0n
        ? ["PARTIAL_DELIVERY", "SIMULATE_FINITE_CAPACITY"]
        : ["SIMULATE_FINITE_CAPACITY"],
    stock_issues: issues.map((i) => i.code),
  };
}
