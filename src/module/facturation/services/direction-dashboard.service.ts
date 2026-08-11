import { HttpError } from "../../../utils/httpError";
import {
  DIRECTION_DASHBOARD_CONTRACT_VERSION,
  DIRECTION_DASHBOARD_TIMEZONE,
  DIRECTION_KPI_DEFINITIONS,
  type DirectionReliability,
} from "../domain/direction-dashboard";
import { addDays, resolvePeriod, todayInParis } from "../domain/reporting-policy";
import {
  repoDirectionCash,
  repoDirectionFilterOptions,
  repoDirectionOrders,
  type DirectionOrderFacts,
  type DirectionRepositoryContext,
  type DirectionRiskCause,
} from "../repository/direction-dashboard.repository";
import type { DirectionDashboardQueryDTO } from "../validators/direction-dashboard.validators";

const RISK_LABELS: Record<DirectionRiskCause, string> = {
  OVERDUE: "Échéance dépassée",
  WORKFLOW_BLOCKED: "Workflow bloqué",
  OF_PAUSED: "OF en pause",
  PRODUCTION_LATE: "Fin de production tardive",
  NO_EXECUTION_PATH: "Couverture d'exécution absente",
  MISSING_DUE_DATE: "Délai client manquant",
};

const RISK_SEVERITY: Record<DirectionRiskCause, "critical" | "warning" | "info"> = {
  OVERDUE: "critical",
  WORKFLOW_BLOCKED: "critical",
  OF_PAUSED: "warning",
  PRODUCTION_LATE: "warning",
  NO_EXECUTION_PATH: "warning",
  MISSING_DUE_DATE: "info",
};

export type DirectionResolvedRequest = DirectionRepositoryContext & {
  preset: string;
};

export function resolveDirectionRequest(
  query: DirectionDashboardQueryDTO,
  now = new Date()
): DirectionResolvedRequest {
  const today = todayInParis(now);
  const period = resolvePeriod({
    preset: query.period,
    from: query.from,
    to: query.to,
    today,
  });
  const asOf = query.as_of ?? today;
  if (asOf < period.from) {
    throw new HttpError(
      400,
      "DIRECTION_AS_OF_BEFORE_PERIOD",
      "La date d'arrêté ne peut pas précéder le début de la période analysée."
    );
  }
  return {
    period,
    asOf,
    siteId: query.site_id,
    clientId: query.client_id,
    currency: query.currency,
    limit: query.limit,
    preset: query.period,
  };
}

type MetricStatus = "available" | "partial" | "unavailable";

type MetricInput = {
  key: keyof typeof DIRECTION_KPI_DEFINITIONS;
  value: number | null;
  currency?: string | null;
  status: MetricStatus;
  reliability: DirectionReliability;
  period: { from: string; to: string; label: string };
  generatedAt: string;
  coverage: Record<string, number>;
  missingInputs: string[];
  drilldown: { total: number; truncated: boolean; items: unknown[] };
  byCurrency?: Array<{ currency: string; amount: number; count: number }>;
};

function metric(input: MetricInput) {
  const definition = DIRECTION_KPI_DEFINITIONS[input.key];
  return {
    key: input.key,
    label: definition.label,
    value: input.value,
    unit: definition.unit,
    currency: input.currency ?? null,
    status: input.status,
    reliability: input.reliability,
    period: { ...input.period, timezone: DIRECTION_DASHBOARD_TIMEZONE },
    formula: definition.formula,
    source: [...definition.source],
    grain: definition.grain,
    freshness: {
      generated_at: input.generatedAt,
      source: "live" as const,
      stale: false,
      max_age_seconds: 0,
    },
    coverage: input.coverage,
    missing_inputs: input.missingInputs,
    drilldown: input.drilldown,
    by_currency: input.byCurrency ?? [],
  };
}

function singleCurrency(
  rows: Array<{ currency: string; amount: number }>,
  requestedCurrency?: string
): { value: number | null; currency: string | null; mixed: boolean } {
  if (rows.length === 0) {
    return requestedCurrency
      ? { value: 0, currency: requestedCurrency, mixed: false }
      : { value: null, currency: null, mixed: false };
  }
  if (rows.length > 1) return { value: null, currency: null, mixed: true };
  return { value: rows[0].amount, currency: rows[0].currency, mixed: false };
}

function buildOrderDrilldown(orders: DirectionOrderFacts) {
  return orders.rows.map((row) => ({
    entity: "order" as const,
    id: row.commande_id,
    reference: row.numero,
    client_id: row.client_id,
    client_name: row.company_name,
    href: `/commandes/${row.commande_id}`,
    promised_date: row.promised_date,
    earliest_remaining_due: row.earliest_remaining_due,
    status: row.current_status,
    amount_ht: row.remaining_ht,
    currency: row.currency,
    risk_cause: row.risk_cause,
    risk_label: row.risk_cause ? RISK_LABELS[row.risk_cause] : null,
    otif_eligible: row.otif_eligible,
    otif_pass: row.otif_pass,
    missing: [
      ...(row.missing_due_lines > 0 ? ["delai_client"] : []),
      ...(row.missing_price_lines > 0 ? ["prix_unitaire_ht"] : []),
    ],
  }));
}

export async function getDirectionDashboard(request: DirectionResolvedRequest) {
  const generatedAt = new Date().toISOString();
  const [orders, filters] = await Promise.all([
    repoDirectionOrders(request),
    repoDirectionFilterOptions(),
  ]);
  const cash = request.siteId ? null : await repoDirectionCash(request);
  const orderDrilldown = buildOrderDrilldown(orders);
  const period = {
    from: request.period.from,
    to: request.period.to,
    label: `Délai contractuel entre ${request.period.from} et ${request.period.to}`,
  };

  const otifMissing = orders.otif.missingDueOrders;
  const otifValue =
    orders.otif.eligible > 0
      ? Math.round((orders.otif.passed / orders.otif.eligible) * 10_000) / 100
      : null;
  const otifStatus: MetricStatus =
    orders.otif.eligible === 0 ? "unavailable" : "partial";
  const otifReliability: DirectionReliability =
    orders.otif.eligible === 0 ? "UNAVAILABLE" : "PARTIAL";
  const otifRows = orderDrilldown.filter((row) => row.otif_eligible);

  const currencyHint =
    request.currency ?? (filters.currencies.length === 1 ? filters.currencies[0] : undefined);
  const delayed = singleCurrency(orders.delayed, currencyHint);
  const delayedHasMissing =
    orders.delayedMissingPriceOrders > 0 || orders.delayedMissingCurrencyOrders > 0;
  const delayedUnavailable =
    delayed.mixed || delayed.value === null ||
    (orders.delayedOrders > 0 && delayed.value === 0 && delayedHasMissing);
  const delayedStatus: MetricStatus = delayedUnavailable
    ? "unavailable"
    : delayedHasMissing
      ? "partial"
      : "available";

  const cashValue = cash
    ? singleCurrency(cash.currencies, currencyHint)
    : { value: null, currency: null, mixed: false };
  const cashHasMissing = (cash?.missingDueInvoices ?? 0) > 0;
  const cashUnavailable = request.siteId !== undefined || cashValue.mixed || cashValue.value === null;
  const cashStatus: MetricStatus = cashUnavailable
    ? "unavailable"
    : cashHasMissing
      ? "partial"
      : "available";

  const metrics = [
    metric({
      key: "otif",
      value: otifValue,
      status: otifStatus,
      reliability: otifReliability,
      period,
      generatedAt,
      coverage: {
        eligible_orders: orders.otif.eligible,
        measured_orders: orders.otif.eligible,
        excluded_missing_due_orders: otifMissing,
      },
      missingInputs: [
        ...(otifMissing > 0 ? ["commande_ligne.delai_client"] : []),
        "Historique versionné des révisions de commande_ligne.delai_client",
      ],
      drilldown: {
        total: orders.otif.eligible,
        truncated: orders.otif.eligible > otifRows.length,
        items: otifRows,
      },
    }),
    metric({
      key: "at_risk_orders",
      value: orders.riskOrders,
      status: "available",
      reliability: "MEASURED",
      period,
      generatedAt,
      coverage: {
        scoped_orders: orders.totalOrders,
        site_mapped_orders: orders.mappedSiteOrders,
        risk_orders: orders.riskOrders,
      },
      missingInputs: [],
      drilldown: {
        total: orders.riskOrders,
        truncated: orders.riskOrders > orderDrilldown.filter((row) => row.risk_cause).length,
        items: orderDrilldown.filter((row) => row.risk_cause),
      },
    }),
    metric({
      key: "overdue_value",
      value: delayedUnavailable ? null : delayed.value,
      currency: delayed.currency,
      status: delayedStatus,
      reliability: delayedUnavailable ? "UNAVAILABLE" : delayedHasMissing ? "PARTIAL" : "MEASURED",
      period,
      generatedAt,
      coverage: {
        delayed_orders: orders.delayedOrders,
        missing_price_orders: orders.delayedMissingPriceOrders,
        missing_currency_orders: orders.delayedMissingCurrencyOrders,
      },
      missingInputs: [
        ...(delayed.mixed ? ["Filtre devise requis : plusieurs devises sont présentes."] : []),
        ...(delayed.value === null && !delayed.mixed
          ? ["Devise non déterminable : choisissez une devise pour exprimer un total monétaire nul."]
          : []),
        ...(orders.delayedMissingPriceOrders > 0 ? ["commande_ligne.prix_unitaire_ht"] : []),
        ...(orders.delayedMissingCurrencyOrders > 0 ? ["clients.devise"] : []),
      ],
      drilldown: {
        total: orders.delayedOrders,
        truncated: orders.delayedOrders > orderDrilldown.filter((row) => row.risk_cause === "OVERDUE").length,
        items: orderDrilldown.filter((row) => row.risk_cause === "OVERDUE"),
      },
      byCurrency: orders.delayed.map((row) => ({
        currency: row.currency,
        amount: row.amount,
        count: row.orders,
      })),
    }),
    metric({
      key: "cash_30d",
      value: cashUnavailable ? null : cashValue.value,
      currency: cashValue.currency,
      status: cashStatus,
      reliability: cashUnavailable ? "UNAVAILABLE" : cashHasMissing ? "PARTIAL" : "MEASURED",
      period: {
        from: request.asOf,
        to: addDays(request.asOf, 30),
        label: "Échéance explicite comprise entre la date d'arrêté et J+30",
      },
      generatedAt,
      coverage: {
        expected_invoices: cash?.totalInvoices ?? 0,
        missing_due_invoices: cash?.missingDueInvoices ?? 0,
      },
      missingInputs: [
        ...(request.siteId
          ? [
              "Le solde d'une facture est au grain facture et ne peut pas être ventilé par site sans règle d'allocation financière validée.",
            ]
          : []),
        ...(cashValue.mixed ? ["Filtre devise requis : plusieurs devises sont présentes."] : []),
        ...(cashValue.value === null && !cashValue.mixed && !request.siteId
          ? ["Devise non déterminable : choisissez une devise pour exprimer un total monétaire nul."]
          : []),
        ...(cashHasMissing ? ["facture.date_echeance"] : []),
      ],
      drilldown: {
        total: cash?.totalInvoices ?? 0,
        truncated: (cash?.totalInvoices ?? 0) > (cash?.invoices.length ?? 0),
        items: (cash?.invoices ?? []).map((invoice) => ({
          entity: "invoice" as const,
          id: invoice.id,
          reference: invoice.numero,
          client_id: invoice.client_id,
          client_name: invoice.company_name,
          href: `/factures/${invoice.id}`,
          due_date: invoice.due_date,
          balance_ttc: invoice.balance_ttc,
          currency: invoice.currency,
        })),
      },
      byCurrency: (cash?.currencies ?? []).map((row) => ({
        currency: row.currency,
        amount: row.amount,
        count: row.invoices,
      })),
    }),
  ];

  return {
    contract_version: DIRECTION_DASHBOARD_CONTRACT_VERSION,
    generated_at: generatedAt,
    as_of: request.asOf,
    timezone: DIRECTION_DASHBOARD_TIMEZONE,
    filters: {
      period: request.preset,
      from: request.period.from,
      to: request.period.to,
      site_id: request.siteId ?? null,
      client_id: request.clientId ?? null,
      currency: request.currency ?? null,
    },
    filter_options: filters,
    metrics,
    otif_12_weeks: orders.series.map((point) => ({
      ...point,
      reliability: point.eligible > 0 ? ("PARTIAL" as const) : ("UNAVAILABLE" as const),
      limitation:
        "La date promise utilisée est la valeur actuelle de commande_ligne.delai_client ; ses révisions passées ne sont pas historisées au grain ligne.",
    })),
    delay_causes: orders.causes.map((cause) => ({
      code: cause.cause,
      label: RISK_LABELS[cause.cause],
      count: cause.count,
    })),
    action_queue: orders.rows
      .filter((row) => row.risk_cause !== null)
      .map((row) => ({
        entity: "order" as const,
        id: row.commande_id,
        reference: row.numero,
        client_id: row.client_id,
        client_name: row.company_name,
        cause: row.risk_cause,
        cause_label: row.risk_cause ? RISK_LABELS[row.risk_cause] : null,
        severity: row.risk_cause ? RISK_SEVERITY[row.risk_cause] : "info",
        detail: row.risk_detail,
        due_date: row.earliest_remaining_due,
        amount_ht: row.remaining_ht,
        currency: row.currency,
        href: `/commandes/${row.commande_id}`,
      })),
    stock_shortage_7d: {
      status: "unavailable" as const,
      value: null,
      unit: "count",
      period: { from: request.asOf, to: addDays(request.asOf, 7), timezone: DIRECTION_DASHBOARD_TIMEZONE },
      source: ["stock_balances", "stock_reservations", "commandes_fournisseurs"],
      freshness: { generated_at: generatedAt, source: "live", stale: false, max_age_seconds: 0 },
      reliability: "UNAVAILABLE" as const,
      reason:
        "La demande datée, les réservations de vente et les réceptions fournisseurs attendues ne partagent pas encore un contrat de projection complet.",
      missing_inputs: [
        "demandes datées par article/site",
        "réceptions fournisseurs attendues et confirmées",
        "règle validée de stock disponible projeté",
      ],
      action: { label: "Ouvrir le réapprovisionnement", href: "/stock/reapprovisionnement" },
    },
    disclosures: [
      "Les dates sont des dates calendaires Europe/Paris ; les bornes sont inclusives.",
      "L'OTIF est figé à la première date d'expédition cumulée atteignant la quantité commandée ; les retours ne réécrivent pas cet historique faute de lien retour-livraison autoritaire.",
      "L'OTIF historique reste de fiabilité PARTIAL : les événements d'expédition sont audités, mais les versions successives du délai client ne sont pas historisées au grain ligne.",
      "Les bons de livraison annulés et les documents financiers annulés sont exclus.",
      "Aucune conversion de devise n'est effectuée : un total multi-devises est indisponible.",
      "Le filtre site utilise l'entrepôt prouvé par destination, réservation ou allocation de livraison ; une commande sans rattachement n'est pas affectée arbitrairement.",
    ],
  };
}
