// Reporting commercial 360 (#275) — assemblage des réponses.
//
// Toute réponse porte la même enveloppe : de quoi savoir, sans quitter l'écran, ce
// qui a été mesuré, sur quelle période, avec quelle base de date, quelle date
// d'arrêté, quelle devise, quelle version de catalogue et quelles limites.
//
// Les comparaisons (période précédente, N-1, pourcentages) sont calculées ICI.
// Aucune addition de montant n'a lieu côté React.

import { HttpError } from "../../../utils/httpError";
import { roleHasFinanceCapability } from "../domain/finance-policy";
import {
  MARGIN_UNAVAILABLE,
  MAX_BUCKETS,
  REPORTING_TIMEZONE,
  estimateBucketCount,
  resolveComparison,
  resolvePeriod,
  summarizeCurrencies,
  todayInParis,
  type ComparisonMode,
  type Granularity,
  type Period,
} from "../domain/reporting-policy";
import {
  METRIC_CATALOG_VERSION,
  listDeferredMetrics,
  listMetrics,
} from "../domain/reporting-metrics";
import {
  repoClients,
  repoCurrencies,
  repoDataQuality,
  repoDeliveries,
  repoDrilldown,
  repoInvoicing,
  repoOrders,
  repoQuotes,
  repoReceivables,
  type Anomaly,
  type ReportingContext,
} from "../repository/reporting-v2.repository";
import type {
  DrilldownQueryDTO,
  ExportQueryDTO,
  ReportingFiltersDTO,
} from "../validators/reporting-v2.validators";

export type ReportingPermissions = {
  reporting_read: boolean;
  reporting_financial: boolean;
  reporting_client_detail: boolean;
  reporting_export: boolean;
};

export function resolvePermissions(role: string | null | undefined): ReportingPermissions {
  return {
    reporting_read: roleHasFinanceCapability(role, "reporting_read"),
    reporting_financial: roleHasFinanceCapability(role, "reporting_financial"),
    reporting_client_detail: roleHasFinanceCapability(role, "reporting_client_detail"),
    reporting_export: roleHasFinanceCapability(role, "reporting_export"),
  };
}

export type Envelope = {
  as_of: string;
  period: { preset: string; from: string; to: string };
  comparison: { mode: ComparisonMode; from: string; to: string } | null;
  date_basis: string;
  timezone: string;
  granularity: Granularity;
  currency: { currencies: string[]; mixed: boolean; reporting_currency: string | null };
  filters: Record<string, string | number | null>;
  grain: string;
  freshness: { generated_at: string; source: "live"; stale: boolean; max_age_seconds: number };
  catalog_version: string;
  metrics: string[];
  coverage: {
    /** Vrai quand un montant global est refusé faute de devise unique. */
    global_total_suppressed: boolean;
    notes: string[];
  };
  anomalies: Anomaly[];
  truncation: Array<{ block: string; returned: number; total: number }>;
  permissions: ReportingPermissions;
  disclaimer: string;
};

export const REPORTING_DISCLAIMER =
  "Indicateurs de pilotage commercial — ne remplacent pas les états comptables validés.";

export type ResolvedRequest = {
  ctx: ReportingContext;
  comparisonCtx: ReportingContext | null;
  preset: string;
  comparisonMode: ComparisonMode;
  filters: Record<string, string | number | null>;
};

/**
 * Traduit les filtres validés en contexte d'exécution.
 * Refuse en amont une combinaison qui produirait un nombre de points ingérable :
 * une borne explicite vaut mieux qu'une troncature silencieuse.
 */
export function resolveRequest(query: ReportingFiltersDTO, now = new Date()): ResolvedRequest {
  const today = todayInParis(now);
  const period: Period = resolvePeriod({
    preset: query.period,
    from: query.from,
    to: query.to,
    today,
  });
  const asOf = query.as_of ?? today;

  if (asOf < period.from) {
    throw new HttpError(
      400,
      "REPORTING_AS_OF_BEFORE_PERIOD",
      "La date d'arrêté ne peut pas précéder le début de la période analysée."
    );
  }

  const buckets = estimateBucketCount(period, query.granularity);
  if (buckets > MAX_BUCKETS) {
    throw new HttpError(
      400,
      "REPORTING_GRANULARITY_TOO_FINE",
      `Cette période produirait ${buckets} points (maximum ${MAX_BUCKETS}). Élargissez la granularité.`
    );
  }

  const comparison = resolveComparison(period, query.compare);

  const base: Omit<ReportingContext, "period"> = {
    asOf,
    basis: query.date_basis,
    granularity: query.granularity,
    clientId: query.client_id,
    currency: query.currency,
    orderType: query.order_type,
    commercialId: query.commercial_id,
    affaireId: query.affaire_id,
    famille: query.famille,
    limit: query.limit,
  };

  return {
    ctx: { ...base, period },
    comparisonCtx: comparison
      ? // La date d'arrêté du comparatif suit la fin de sa propre période :
        // comparer un encours d'aujourd'hui à un encours d'aujourd'hui n'aurait aucun sens.
        { ...base, period: comparison, asOf: comparison.to }
      : null,
    preset: query.period,
    comparisonMode: query.compare,
    filters: {
      client_id: query.client_id ?? null,
      currency: query.currency ?? null,
      order_type: query.order_type ?? null,
      commercial_id: query.commercial_id ?? null,
      affaire_id: query.affaire_id ?? null,
      famille: query.famille ?? null,
      limit: query.limit,
    },
  };
}

export type EnvelopeInput = {
  request: ResolvedRequest;
  permissions: ReportingPermissions;
  metrics: string[];
  grain: string;
  currencies: string[];
  anomalies: Anomaly[];
  truncation: Array<{ block: string; returned: number; total: number }>;
  notes?: string[];
};

export function buildEnvelope(input: EnvelopeInput, now = new Date()): Envelope {
  const { request } = input;
  const currency = summarizeCurrencies(input.currencies.map((code) => ({ currency: code })));
  const notes = [...(input.notes ?? [])];
  if (currency.mixed) {
    notes.push(
      "Plusieurs devises sur le périmètre : aucun total global n'est produit (pas de table de taux datés)."
    );
  }

  return {
    as_of: request.ctx.asOf,
    period: { preset: request.preset, from: request.ctx.period.from, to: request.ctx.period.to },
    comparison: request.comparisonCtx
      ? {
          mode: request.comparisonMode,
          from: request.comparisonCtx.period.from,
          to: request.comparisonCtx.period.to,
        }
      : null,
    date_basis: request.ctx.basis,
    timezone: REPORTING_TIMEZONE,
    granularity: request.ctx.granularity,
    currency,
    filters: request.filters,
    grain: input.grain,
    freshness: {
      generated_at: now.toISOString(),
      source: "live",
      stale: false,
      max_age_seconds: 0,
    },
    catalog_version: METRIC_CATALOG_VERSION,
    metrics: input.metrics,
    coverage: { global_total_suppressed: currency.mixed, notes },
    anomalies: input.anomalies,
    truncation: input.truncation,
    permissions: input.permissions,
    disclaimer: REPORTING_DISCLAIMER,
  };
}

export type Delta = { previous: number; absolute: number; relative: number | null };

/**
 * Écart entre deux mesures. `relative` est `null` quand la base est nulle ou
 * négative : un « +∞ % » ou un pourcentage calculé sur une base négative ne veut
 * rien dire et se retrouverait affiché tel quel.
 */
export function delta(current: number, previous: number): Delta {
  const absolute = Math.round((current - previous + Number.EPSILON) * 100) / 100;
  return {
    previous,
    absolute,
    relative: previous > 0 ? absolute / previous : null,
  };
}

function guard(permissions: ReportingPermissions, capability: keyof ReportingPermissions): void {
  if (!permissions[capability]) {
    throw new HttpError(
      403,
      "FINANCE_CAPABILITY_REQUIRED",
      `La capacité Finance '${capability}' est requise.`
    );
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export async function getQuotesSection(request: ResolvedRequest, permissions: ReportingPermissions) {
  guard(permissions, "reporting_read");
  const [current, previous, currencies, anomalies] = await Promise.all([
    repoQuotes(request.ctx),
    request.comparisonCtx ? repoQuotes(request.comparisonCtx) : Promise.resolve(null),
    repoCurrencies(request.ctx),
    repoDataQuality(request.ctx),
  ]);

  const truncation = current.top_open_truncated
    ? [{ block: "top_open", returned: current.top_open.length, total: current.open_count }]
    : [];

  return {
    envelope: buildEnvelope({
      request,
      permissions,
      metrics: [
        "quotes.issued.count",
        "quotes.issued.amount_ht",
        "quotes.decision_rate",
        "quotes.win_rate",
        "quotes.open.amount_ht",
      ],
      grain: "Un devis (en-tête). Cohorte par date de création.",
      currencies,
      anomalies,
      truncation,
      notes: [
        "Aucune date de décision n'est historisée : les taux décrivent l'état COURANT d'une cohorte de création, pas un flux daté.",
      ],
    }),
    data: current,
    comparison: previous
      ? {
          issued_count: delta(current.issued_count, previous.issued_count),
          issued_amount_ht: delta(current.issued_amount_ht, previous.issued_amount_ht),
          won_amount_ht: delta(current.won_amount_ht, previous.won_amount_ht),
        }
      : null,
    deferred: listDeferredMetrics().filter((metric) => metric.family === "devis"),
  };
}

export async function getOrdersSection(request: ResolvedRequest, permissions: ReportingPermissions) {
  guard(permissions, "reporting_read");
  const [current, previous, currencies, anomalies] = await Promise.all([
    repoOrders(request.ctx),
    request.comparisonCtx ? repoOrders(request.comparisonCtx) : Promise.resolve(null),
    repoCurrencies(request.ctx),
    repoDataQuality(request.ctx),
  ]);

  return {
    envelope: buildEnvelope({
      request,
      permissions,
      metrics: [
        "orders.booked.count",
        "orders.booked.amount_ht",
        "orders.backlog.amount_ht",
        "orders.overdue_lines.count",
      ],
      grain: "Une commande pour les prises, une ligne de commande pour le carnet.",
      currencies,
      anomalies,
      truncation: current.top_backlog_truncated
        ? [{ block: "top_backlog", returned: current.top_backlog.length, total: current.backlog_lines }]
        : [],
      notes: [
        "`commande_client` ne porte aucun statut : une commande annulée n'est pas distinguable. Le carnet repose sur les quantités de lignes.",
        "Les commandes internes sont comptées à part et jamais additionnées au commercial.",
      ],
    }),
    data: current,
    comparison: previous
      ? {
          booked_count: delta(current.booked_count, previous.booked_count),
          booked_amount_ht: delta(current.booked_amount_ht, previous.booked_amount_ht),
          backlog_amount_ht: delta(current.backlog_amount_ht, previous.backlog_amount_ht),
        }
      : null,
    deferred: [],
  };
}

export async function getDeliveriesSection(
  request: ResolvedRequest,
  permissions: ReportingPermissions
) {
  guard(permissions, "reporting_read");
  const [current, previous, currencies, anomalies] = await Promise.all([
    repoDeliveries(request.ctx),
    request.comparisonCtx ? repoDeliveries(request.comparisonCtx) : Promise.resolve(null),
    repoCurrencies(request.ctx),
    repoDataQuality(request.ctx),
  ]);

  return {
    envelope: buildEnvelope({
      request,
      permissions,
      metrics: [
        "deliveries.shipped.count",
        "deliveries.delivered.count",
        "deliveries.shipped.amount_ht",
        "deliveries.on_time_rate",
      ],
      grain: "Un bon de livraison pour les volumes, une ligne pour la ponctualité.",
      currencies,
      anomalies,
      truncation: current.top_late_truncated
        ? [{ block: "top_late", returned: current.top_late.length, total: current.late_lines }]
        : [],
      notes: [
        "Taux de ponctualité calculé à la LIGNE. Ce n'est pas un OTIF : « complet » n'a pas de définition validée dans le CERP.",
      ],
    }),
    data: current,
    comparison: previous
      ? {
          shipped_count: delta(current.shipped_count, previous.shipped_count),
          shipped_amount_ht: delta(current.shipped_amount_ht, previous.shipped_amount_ht),
        }
      : null,
    deferred: listDeferredMetrics().filter((metric) => metric.family === "livraisons"),
  };
}

export async function getInvoicingSection(
  request: ResolvedRequest,
  permissions: ReportingPermissions
) {
  guard(permissions, "reporting_financial");
  const [current, previous, currencies, anomalies] = await Promise.all([
    repoInvoicing(request.ctx),
    request.comparisonCtx ? repoInvoicing(request.comparisonCtx) : Promise.resolve(null),
    repoCurrencies(request.ctx),
    repoDataQuality(request.ctx),
  ]);

  return {
    envelope: buildEnvelope({
      request,
      permissions,
      metrics: [
        "invoicing.gross.amount_ht",
        "invoicing.credits.amount_ht",
        "invoicing.net.amount_ht",
        "invoicing.tax.amount",
        "cash.collected.amount_ttc",
        "cash.collection_rate",
      ],
      grain: "Une pièce financière (facture ou avoir).",
      currencies,
      anomalies,
      truncation: [],
      notes: [
        "« Facturé net » et non « chiffre d'affaires » : aucune règle comptable de rattachement n'a été validée.",
        "La TVA affichée est l'écart TTC − HT, pas une donnée fiscale autoritaire.",
      ],
    }),
    data: current,
    comparison: previous
      ? {
          net_ht: delta(current.net_ht, previous.net_ht),
          net_ttc: delta(current.net_ttc, previous.net_ttc),
          collected_ttc: delta(current.collected_ttc, previous.collected_ttc),
        }
      : null,
    margin: MARGIN_UNAVAILABLE,
    deferred: [],
  };
}

export async function getReceivablesSection(
  request: ResolvedRequest,
  permissions: ReportingPermissions
) {
  guard(permissions, "reporting_financial");
  const [current, previous, currencies, anomalies] = await Promise.all([
    repoReceivables(request.ctx),
    request.comparisonCtx ? repoReceivables(request.comparisonCtx) : Promise.resolve(null),
    repoCurrencies(request.ctx),
    repoDataQuality(request.ctx),
  ]);

  return {
    envelope: buildEnvelope({
      request,
      permissions,
      metrics: [
        "receivables.open.amount_ttc",
        "receivables.overdue.amount_ttc",
        "receivables.aging",
        "receivables.unallocated_payments.amount_ttc",
        "receivables.unallocated_credits.amount_ttc",
        "receivables.credit_balance.amount_ttc",
      ],
      grain: "Une facture du registre, soldée à la date d'arrêté.",
      currencies,
      anomalies,
      truncation: current.top_overdue_truncated
        ? [{ block: "top_overdue", returned: current.top_overdue.length, total: current.overdue_count }]
        : [],
      notes: [
        "Reconstruction stricte à la date d'arrêté : aucun règlement ni avoir postérieur n'entre dans le calcul.",
        "Les règlements et avoirs non affectés ne réduisent aucune créance ; ils sont exposés à part.",
      ],
    }),
    data: current,
    comparison: previous
      ? {
          open_ttc: delta(current.open_ttc, previous.open_ttc),
          overdue_ttc: delta(current.overdue_ttc, previous.overdue_ttc),
        }
      : null,
    deferred: listDeferredMetrics().filter((metric) => metric.id === "cash.dso"),
  };
}

export async function getClientsSection(request: ResolvedRequest, permissions: ReportingPermissions) {
  guard(permissions, "reporting_client_detail");
  const [current, previous, currencies, anomalies] = await Promise.all([
    repoClients(request.ctx),
    request.comparisonCtx ? repoClients(request.comparisonCtx) : Promise.resolve(null),
    repoCurrencies(request.ctx),
    repoDataQuality(request.ctx),
  ]);

  return {
    envelope: buildEnvelope({
      request,
      permissions,
      metrics: ["clients.top.net_ht", "clients.concentration.top5_share"],
      grain: "Un client.",
      currencies,
      anomalies,
      truncation: current.truncated
        ? [{ block: "items", returned: current.items.length, total: current.client_count }]
        : [],
      notes: [
        "Le classement et le total partagent exactement le même périmètre : la somme de tous les clients est égale au facturé net de la période.",
        "Aucune coordonnée personnelle (e-mail, téléphone, adresse, contact) n'est exposée par le reporting.",
      ],
    }),
    data: current,
    comparison: previous
      ? { net_ht_total: delta(current.net_ht_total, previous.net_ht_total) }
      : null,
    deferred: listDeferredMetrics().filter((metric) => metric.family === "clients"),
  };
}

/**
 * Synthèse. Chaque bloc est indépendant : un bloc refusé ou en erreur n'empêche
 * pas les autres de s'afficher. C'est le serveur qui décide de ce qui est inclus,
 * l'interface ne devine rien.
 */
export async function getOverview(request: ResolvedRequest, permissions: ReportingPermissions) {
  guard(permissions, "reporting_read");

  const [quotes, orders, deliveries, currencies, anomalies] = await Promise.all([
    repoQuotes(request.ctx),
    repoOrders(request.ctx),
    repoDeliveries(request.ctx),
    repoCurrencies(request.ctx),
    repoDataQuality(request.ctx),
  ]);

  const invoicing = permissions.reporting_financial ? await repoInvoicing(request.ctx) : null;
  const receivables = permissions.reporting_financial ? await repoReceivables(request.ctx) : null;
  const clients = permissions.reporting_client_detail ? await repoClients(request.ctx) : null;

  let comparison: Record<string, Delta> | null = null;
  if (request.comparisonCtx) {
    const [prevQuotes, prevOrders, prevDeliveries] = await Promise.all([
      repoQuotes(request.comparisonCtx),
      repoOrders(request.comparisonCtx),
      repoDeliveries(request.comparisonCtx),
    ]);
    comparison = {
      quotes_issued_amount_ht: delta(quotes.issued_amount_ht, prevQuotes.issued_amount_ht),
      orders_booked_amount_ht: delta(orders.booked_amount_ht, prevOrders.booked_amount_ht),
      deliveries_shipped_amount_ht: delta(
        deliveries.shipped_amount_ht,
        prevDeliveries.shipped_amount_ht
      ),
    };
    if (invoicing) {
      const prevInvoicing = await repoInvoicing(request.comparisonCtx);
      comparison.invoicing_net_ht = delta(invoicing.net_ht, prevInvoicing.net_ht);
      comparison.cash_collected_ttc = delta(invoicing.collected_ttc, prevInvoicing.collected_ttc);
    }
    if (receivables) {
      const prevReceivables = await repoReceivables(request.comparisonCtx);
      comparison.receivables_open_ttc = delta(receivables.open_ttc, prevReceivables.open_ttc);
    }
  }

  const metrics = [
    "quotes.issued.amount_ht",
    "quotes.win_rate",
    "orders.booked.amount_ht",
    "orders.backlog.amount_ht",
    "deliveries.shipped.amount_ht",
    "deliveries.on_time_rate",
  ];
  if (invoicing) metrics.push("invoicing.net.amount_ht", "cash.collected.amount_ttc");
  if (receivables) metrics.push("receivables.open.amount_ttc", "receivables.overdue.amount_ttc");
  if (clients) metrics.push("clients.concentration.top5_share");

  const notes: string[] = [];
  if (!invoicing) {
    notes.push(
      "Bloc Facturation & encours masqué : la capacité 'reporting_financial' est requise."
    );
  }
  if (!clients) {
    notes.push("Bloc Clients masqué : la capacité 'reporting_client_detail' est requise.");
  }

  return {
    envelope: buildEnvelope({
      request,
      permissions,
      metrics,
      grain: "Synthèse multi-grain : voir chaque bloc.",
      currencies,
      anomalies,
      truncation: [],
      notes,
    }),
    data: {
      quotes: {
        issued_count: quotes.issued_count,
        issued_amount_ht: quotes.issued_amount_ht,
        win_rate: quotes.win_rate,
        decision_rate: quotes.decision_rate,
        open_amount_ht: quotes.open_amount_ht,
        open_count: quotes.open_count,
        series: quotes.series,
      },
      orders: {
        booked_count: orders.booked_count,
        booked_amount_ht: orders.booked_amount_ht,
        backlog_amount_ht: orders.backlog_amount_ht,
        backlog_lines: orders.backlog_lines,
        overdue_lines: orders.overdue_lines,
        series: orders.series,
      },
      deliveries: {
        shipped_count: deliveries.shipped_count,
        delivered_count: deliveries.delivered_count,
        shipped_amount_ht: deliveries.shipped_amount_ht,
        on_time_rate: deliveries.on_time_rate,
        series: deliveries.series,
      },
      invoicing: invoicing
        ? {
            gross_ht: invoicing.gross_ht,
            credits_ht: invoicing.credits_ht,
            net_ht: invoicing.net_ht,
            net_ttc: invoicing.net_ttc,
            collected_ttc: invoicing.collected_ttc,
            collection_rate: invoicing.collection_rate,
            series: invoicing.series,
          }
        : null,
      receivables: receivables
        ? {
            open_ttc: receivables.open_ttc,
            overdue_ttc: receivables.overdue_ttc,
            credit_balance_ttc: receivables.credit_balance_ttc,
            unallocated_payments_ttc: receivables.unallocated_payments_ttc,
            unallocated_credits_ttc: receivables.unallocated_credits_ttc,
            aging: receivables.aging,
          }
        : null,
      clients: clients
        ? {
            client_count: clients.client_count,
            top5_share: clients.top5_share,
            top10_share: clients.top10_share,
            new_clients: clients.new_clients,
            recurring_clients: clients.recurring_clients,
            dormant_clients: clients.dormant_clients,
            items: clients.items,
          }
        : null,
      margin: MARGIN_UNAVAILABLE,
    },
    comparison,
  };
}

export function getDefinitions(request: ResolvedRequest, permissions: ReportingPermissions) {
  guard(permissions, "reporting_read");
  return {
    envelope: buildEnvelope({
      request,
      permissions,
      metrics: listMetrics().map((metric) => metric.id),
      grain: "Une définition de métrique.",
      currencies: [],
      anomalies: [],
      truncation: [],
    }),
    data: {
      catalog_version: METRIC_CATALOG_VERSION,
      metrics: listMetrics(),
      deferred: listDeferredMetrics().map((metric) => metric.id),
      margin: MARGIN_UNAVAILABLE,
    },
  };
}

const DRILLDOWN_CAPABILITY: Record<string, keyof ReportingPermissions> = {
  quotes: "reporting_read",
  orders: "reporting_read",
  order_lines: "reporting_read",
  deliveries: "reporting_read",
  invoices: "reporting_financial",
  credit_notes: "reporting_financial",
  payments: "reporting_financial",
  clients: "reporting_client_detail",
};

export async function getDrilldown(
  request: ResolvedRequest,
  query: DrilldownQueryDTO,
  permissions: ReportingPermissions
) {
  guard(permissions, "reporting_read");
  guard(permissions, DRILLDOWN_CAPABILITY[query.entity] ?? "reporting_financial");

  const result = await repoDrilldown(request.ctx, query.entity, query.scope);
  const [currencies, anomalies] = await Promise.all([
    repoCurrencies(request.ctx),
    repoDataQuality(request.ctx),
  ]);

  return {
    envelope: buildEnvelope({
      request,
      permissions,
      metrics: [],
      grain: `Une ligne de type « ${query.entity} ».`,
      currencies,
      anomalies,
      truncation: result.truncated
        ? [{ block: query.entity, returned: result.rows.length, total: result.total }]
        : [],
    }),
    data: result,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXPORT_CAPABILITY: Record<string, keyof ReportingPermissions> = {
  overview: "reporting_read",
  quotes: "reporting_read",
  orders: "reporting_read",
  deliveries: "reporting_read",
  invoicing: "reporting_financial",
  receivables: "reporting_financial",
  clients: "reporting_client_detail",
};

export type ExportPayload = {
  filename: string;
  content: string;
  checksum_sha256: string;
  rows: number;
};

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(";");
}

/**
 * Export gouverné : en-tête de provenance obligatoire (période, arrêté, filtres,
 * devise, auteur, version de catalogue, avertissements), puis les données.
 * Aucune coordonnée personnelle n'y figure : le reporting n'exporte que des
 * identifiants et des raisons sociales.
 */
export async function buildExport(
  request: ResolvedRequest,
  query: ExportQueryDTO,
  permissions: ReportingPermissions,
  author: { id: number; username: string },
  now = new Date()
): Promise<ExportPayload> {
  guard(permissions, "reporting_export");
  guard(permissions, EXPORT_CAPABILITY[query.section] ?? "reporting_financial");

  const section = await loadExportSection(request, query.section, permissions);
  const header: string[] = [
    csvLine(["# Rapport", `Reporting commercial 360 — ${query.section}`]),
    csvLine(["# Version du catalogue", section.envelope.catalog_version]),
    csvLine(["# Période", `${section.envelope.period.from} → ${section.envelope.period.to}`]),
    csvLine(["# Date d'arrêté", section.envelope.as_of]),
    csvLine(["# Base de date", section.envelope.date_basis]),
    csvLine(["# Fuseau", section.envelope.timezone]),
    csvLine([
      "# Devises",
      section.envelope.currency.currencies.length
        ? section.envelope.currency.currencies.join("|")
        : "aucune donnée",
    ]),
    csvLine([
      "# Filtres",
      Object.entries(section.envelope.filters)
        .filter(([, value]) => value !== null && value !== "")
        .map(([key, value]) => `${key}=${value}`)
        .join(" ") || "aucun",
    ]),
    csvLine(["# Généré le", now.toISOString()]),
    csvLine(["# Auteur", `${author.username} (#${author.id})`]),
    csvLine(["# Avertissement", REPORTING_DISCLAIMER]),
  ];
  for (const note of section.envelope.coverage.notes) header.push(csvLine(["# Couverture", note]));
  for (const anomaly of section.envelope.anomalies) {
    header.push(csvLine(["# Anomalie", `${anomaly.label}: ${anomaly.count}`]));
  }
  for (const truncation of section.envelope.truncation) {
    header.push(
      csvLine([
        "# Troncature",
        `${truncation.block}: ${truncation.returned} lignes sur ${truncation.total}`,
      ])
    );
  }

  const { columns, rows } = flattenForCsv(query.section, section.data);
  const body = [csvLine(columns), ...rows.map((row) => csvLine(columns.map((c) => row[c])))];
  const content = [...header, "", ...body].join("\r\n");

  const { createHash } = await import("node:crypto");
  const checksum = createHash("sha256").update(content, "utf8").digest("hex");

  return {
    filename: `reporting-commercial-${query.section}-${section.envelope.period.from}_${section.envelope.period.to}.csv`,
    content,
    checksum_sha256: checksum,
    rows: rows.length,
  };
}

async function loadExportSection(
  request: ResolvedRequest,
  section: ExportQueryDTO["section"],
  permissions: ReportingPermissions
): Promise<{ envelope: Envelope; data: unknown }> {
  switch (section) {
    case "quotes":
      return getQuotesSection(request, permissions);
    case "orders":
      return getOrdersSection(request, permissions);
    case "deliveries":
      return getDeliveriesSection(request, permissions);
    case "invoicing":
      return getInvoicingSection(request, permissions);
    case "receivables":
      return getReceivablesSection(request, permissions);
    case "clients":
      return getClientsSection(request, permissions);
    case "overview":
    default:
      return getOverview(request, permissions);
  }
}

/** Aplatit la section en table CSV. Les blocs de détail priment sur les scalaires. */
function flattenForCsv(
  section: ExportQueryDTO["section"],
  data: unknown
): { columns: string[]; rows: Array<Record<string, unknown>> } {
  const record = (data ?? {}) as Record<string, unknown>;
  const detailKey =
    section === "clients"
      ? "items"
      : section === "receivables"
        ? "top_overdue"
        : section === "orders"
          ? "top_backlog"
          : section === "quotes"
            ? "top_open"
            : section === "deliveries"
              ? "top_late"
              : null;

  const detail = detailKey ? record[detailKey] : null;
  if (Array.isArray(detail) && detail.length > 0) {
    const columns = Object.keys(detail[0] as Record<string, unknown>);
    return { columns, rows: detail as Array<Record<string, unknown>> };
  }

  const scalars: Array<Record<string, unknown>> = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === null || typeof value === "object") continue;
    scalars.push({ indicateur: key, valeur: value });
  }
  return { columns: ["indicateur", "valeur"], rows: scalars };
}
