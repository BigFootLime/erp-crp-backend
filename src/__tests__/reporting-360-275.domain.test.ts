// Reporting commercial 360 (#275) — domaine pur.
// Périodes, fuseau Europe/Paris, comparaisons, catalogue de métriques, devises,
// indisponibilité de la marge, capacités.

import { describe, it, expect } from "vitest";

import {
  AVOIR_EXCLUDED_STATUSES,
  AVOIR_LEDGER_STATUSES,
  BL_SHIPPED_STATUSES,
  DEVIS_STATUSES,
  FACTURE_CANCELLED_STATUSES,
  FACTURE_EXCLUDED_STATUSES,
  FACTURE_LEDGER_STATUSES,
  MARGIN_UNAVAILABLE,
  MAX_BUCKETS,
  PAIEMENT_EXCLUDED_STATUSES,
  REPORTING_CAPABILITIES,
  REPORTING_TIMEZONE,
  addDays,
  addMonths,
  assertIsoDate,
  daysBetween,
  endOfMonth,
  estimateBucketCount,
  ledgerDateExpression,
  resolveComparison,
  resolvePeriod,
  startOfMonth,
  summarizeCurrencies,
  todayInParis,
  truncExpression,
} from "../module/facturation/domain/reporting-policy";
import {
  METRIC_CATALOG_VERSION,
  getMetric,
  isKnownMetric,
  listDeferredMetrics,
  listMetrics,
  listMetricsByFamily,
} from "../module/facturation/domain/reporting-metrics";
import { roleHasFinanceCapability } from "../module/facturation/domain/finance-policy";
import { delta, resolvePermissions } from "../module/facturation/services/reporting-v2.service";
import { money, ratio, count, AGING_BUCKETS } from "../module/facturation/repository/reporting-sql";

describe("#275 fuseau Europe/Paris", () => {
  it("renvoie la date française à 00:30 heure de Paris (toISOString aurait renvoyé la veille)", () => {
    // 2026-07-25T22:30:00Z = 2026-07-26 00:30 à Paris (UTC+2 en été).
    const instant = new Date("2026-07-25T22:30:00Z");
    expect(instant.toISOString().slice(0, 10)).toBe("2026-07-25");
    expect(todayInParis(instant)).toBe("2026-07-26");
  });

  it("renvoie la date française à 01:00 en hiver (UTC+1)", () => {
    const instant = new Date("2026-01-15T00:30:00Z");
    expect(todayInParis(instant)).toBe("2026-01-15");
  });

  it("bascule au 1er janvier à 23:30 UTC le 31 décembre", () => {
    const instant = new Date("2025-12-31T23:30:00Z");
    expect(todayInParis(instant)).toBe("2026-01-01");
  });

  it("expose Europe/Paris comme fuseau de référence", () => {
    expect(REPORTING_TIMEZONE).toBe("Europe/Paris");
  });
});

describe("#275 validation de date", () => {
  it("accepte une date réelle", () => {
    expect(assertIsoDate("2026-02-28", "as_of")).toBe("2026-02-28");
  });

  it("refuse le 31 février", () => {
    expect(() => assertIsoDate("2026-02-31", "as_of")).toThrow();
  });

  it("refuse un format libre", () => {
    expect(() => assertIsoDate("26/02/2026", "as_of")).toThrow();
  });

  it("accepte le 29 février d'une année bissextile", () => {
    expect(assertIsoDate("2024-02-29", "as_of")).toBe("2024-02-29");
  });

  it("refuse le 29 février d'une année non bissextile", () => {
    expect(() => assertIsoDate("2026-02-29", "as_of")).toThrow();
  });
});

describe("#275 arithmétique de dates", () => {
  it("ajoute des jours en franchissant un mois", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("retire des jours en franchissant une année", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("ajoute des mois en écrêtant au dernier jour", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("retire douze mois sans dériver", () => {
    expect(addMonths("2026-07-26", -12)).toBe("2025-07-26");
  });

  it("calcule un nombre de jours inclusif via daysBetween + 1", () => {
    expect(daysBetween("2026-07-01", "2026-07-31") + 1).toBe(31);
  });

  it("donne le premier et le dernier jour du mois", () => {
    expect(startOfMonth("2026-07-15")).toBe("2026-07-01");
    expect(endOfMonth("2026-07-15")).toBe("2026-07-31");
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28");
  });
});

describe("#275 résolution de période", () => {
  const today = "2026-07-26";

  it("mois courant", () => {
    expect(resolvePeriod({ preset: "current_month", today })).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
    });
  });

  it("mois précédent", () => {
    expect(resolvePeriod({ preset: "last_month", today })).toEqual({
      from: "2026-06-01",
      to: "2026-06-30",
    });
  });

  it("trimestre courant", () => {
    expect(resolvePeriod({ preset: "current_quarter", today })).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
    });
  });

  it("année courante", () => {
    expect(resolvePeriod({ preset: "current_year", today })).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
  });

  it("année précédente", () => {
    expect(resolvePeriod({ preset: "last_year", today })).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it("30 derniers jours, bornes inclusives (30 jours exactement)", () => {
    const period = resolvePeriod({ preset: "last_30_days", today });
    expect(period).toEqual({ from: "2026-06-27", to: "2026-07-26" });
    expect(daysBetween(period.from, period.to) + 1).toBe(30);
  });

  it("12 derniers mois s'aligne sur des mois pleins", () => {
    expect(resolvePeriod({ preset: "last_12_months", today })).toEqual({
      from: "2025-08-01",
      to: "2026-07-31",
    });
  });

  it("période personnalisée respecte les bornes fournies", () => {
    expect(resolvePeriod({ preset: "custom", from: "2026-03-05", to: "2026-04-10", today })).toEqual({
      from: "2026-03-05",
      to: "2026-04-10",
    });
  });

  it("période personnalisée inversée est refusée", () => {
    expect(() => resolvePeriod({ preset: "custom", from: "2026-05-01", to: "2026-04-01", today })).toThrow();
  });

  it("période personnalisée d'un seul jour est acceptée", () => {
    expect(resolvePeriod({ preset: "custom", from: today, to: today, today })).toEqual({
      from: today,
      to: today,
    });
  });
});

describe("#275 périodes comparatives", () => {
  it("aucune comparaison quand le mode est none", () => {
    expect(resolveComparison({ from: "2026-07-01", to: "2026-07-31" }, "none")).toBeNull();
  });

  it("un mois entier se compare au mois calendaire précédent", () => {
    expect(resolveComparison({ from: "2026-07-01", to: "2026-07-31" }, "previous_period")).toEqual({
      from: "2026-06-01",
      to: "2026-06-30",
    });
  });

  it("une année entière se compare à l'année calendaire précédente", () => {
    expect(resolveComparison({ from: "2026-01-01", to: "2026-12-31" }, "previous_period")).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it("un trimestre entier se compare au trimestre précédent", () => {
    expect(resolveComparison({ from: "2026-07-01", to: "2026-09-30" }, "previous_period")).toEqual({
      from: "2026-04-01",
      to: "2026-06-30",
    });
  });

  it("une période libre recule d'exactement sa durée en jours", () => {
    const current = { from: "2026-06-27", to: "2026-07-26" };
    const previous = resolveComparison(current, "previous_period")!;
    expect(daysBetween(previous.from, previous.to)).toBe(daysBetween(current.from, current.to));
    expect(previous).toEqual({ from: "2026-05-28", to: "2026-06-26" });
  });

  it("N-1 recule d'un an calendaire", () => {
    expect(resolveComparison({ from: "2026-07-01", to: "2026-07-31" }, "previous_year")).toEqual({
      from: "2025-07-01",
      to: "2025-07-31",
    });
  });

  it("les deux périodes ne se chevauchent jamais en mode période précédente", () => {
    const current = { from: "2026-07-15", to: "2026-07-20" };
    const previous = resolveComparison(current, "previous_period")!;
    expect(previous.to < current.from).toBe(true);
  });
});

describe("#275 granularité et bornes de compartiments", () => {
  it("produit l'expression de troncature attendue", () => {
    expect(truncExpression("day", "x")).toBe("x::date");
    expect(truncExpression("week", "x")).toContain("date_trunc('week'");
    expect(truncExpression("month", "x")).toContain("date_trunc('month'");
    expect(truncExpression("quarter", "x")).toContain("date_trunc('quarter'");
    expect(truncExpression("year", "x")).toContain("date_trunc('year'");
  });

  it("un an au jour reste sous la borne", () => {
    expect(estimateBucketCount({ from: "2026-01-01", to: "2026-12-31" }, "day")).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it("dix ans au jour dépasse la borne (refus explicite plutôt que troncature)", () => {
    expect(estimateBucketCount({ from: "2016-01-01", to: "2026-12-31" }, "day")).toBeGreaterThan(MAX_BUCKETS);
  });

  it("dix ans au mois reste sous la borne", () => {
    expect(estimateBucketCount({ from: "2016-01-01", to: "2026-12-31" }, "month")).toBeLessThanOrEqual(MAX_BUCKETS);
  });
});

describe("#275 base de date", () => {
  it("document_date lit la date portée par la pièce", () => {
    expect(ledgerDateExpression("f", "document_date")).toBe("f.date_emission");
  });

  it("issue_date convertit l'horodatage d'émission en date française avec repli", () => {
    const expression = ledgerDateExpression("f", "issue_date");
    expect(expression).toContain("AT TIME ZONE 'Europe/Paris'");
    expect(expression).toContain("COALESCE");
    expect(expression).toContain("f.date_emission");
  });
});

describe("#275 vocabulaire de statut", () => {
  it("le registre des factures contient les statuts canoniques #227", () => {
    for (const status of ["ISSUED", "PARTIALLY_PAID", "PAID"]) {
      expect(FACTURE_LEDGER_STATUSES).toContain(status);
    }
  });

  it("le registre des factures contient l'héritage minuscule", () => {
    for (const status of ["emise", "emis", "envoyee", "partielle", "payee"]) {
      expect(FACTURE_LEDGER_STATUSES).toContain(status);
    }
  });

  it("aucune facture annulée n'entre au registre", () => {
    for (const status of FACTURE_CANCELLED_STATUSES) {
      expect(FACTURE_LEDGER_STATUSES).not.toContain(status);
      expect(FACTURE_EXCLUDED_STATUSES).toContain(status);
    }
  });

  it("aucun brouillon ni statut de validation n'entre au registre", () => {
    for (const status of ["DRAFT", "PENDING_VALIDATION", "APPROVED", "brouillon"]) {
      expect(FACTURE_LEDGER_STATUSES).not.toContain(status);
      expect(FACTURE_EXCLUDED_STATUSES).toContain(status);
    }
  });

  it("registre et exclusions de facture sont disjoints", () => {
    const ledger = new Set<string>(FACTURE_LEDGER_STATUSES);
    for (const status of FACTURE_EXCLUDED_STATUSES) expect(ledger.has(status)).toBe(false);
  });

  it("seuls les avoirs finalisés diminuent le facturé", () => {
    expect(AVOIR_LEDGER_STATUSES).toContain("ISSUED");
    expect(AVOIR_LEDGER_STATUSES).not.toContain("DRAFT");
    expect(AVOIR_LEDGER_STATUSES).not.toContain("APPROVED");
  });

  it("registre et exclusions d'avoir sont disjoints", () => {
    const ledger = new Set<string>(AVOIR_LEDGER_STATUSES);
    for (const status of AVOIR_EXCLUDED_STATUSES) expect(ledger.has(status)).toBe(false);
  });

  it("le vocabulaire de devis correspond à devis_statut_check", () => {
    expect([...DEVIS_STATUSES]).toEqual(["BROUILLON", "ENVOYE", "ACCEPTE", "REFUSE", "EXPIRE", "ANNULE"]);
  });

  it("un BL consomme la commande dès SHIPPED, comme la vue reliquats", () => {
    expect([...BL_SHIPPED_STATUSES]).toEqual(["SHIPPED", "DELIVERED"]);
  });

  it("les règlements rejetés et extournés sont exclus des encaissements", () => {
    expect([...PAIEMENT_EXCLUDED_STATUSES]).toEqual(["REJECTED", "REVERSED"]);
  });
});

describe("#275 devises", () => {
  it("une seule devise autorise un total global", () => {
    const coverage = summarizeCurrencies([{ currency: "EUR" }, { currency: "eur" }]);
    expect(coverage.currencies).toEqual(["EUR"]);
    expect(coverage.mixed).toBe(false);
    expect(coverage.reporting_currency).toBe("EUR");
  });

  it("deux devises interdisent un total global", () => {
    const coverage = summarizeCurrencies([{ currency: "EUR" }, { currency: "USD" }]);
    expect(coverage.mixed).toBe(true);
    expect(coverage.reporting_currency).toBeNull();
  });

  it("aucune donnée ne prétend à une devise", () => {
    const coverage = summarizeCurrencies([]);
    expect(coverage.currencies).toEqual([]);
    expect(coverage.reporting_currency).toBeNull();
  });

  it("ignore les valeurs vides sans inventer EUR", () => {
    expect(summarizeCurrencies([{ currency: null }, { currency: "  " }]).currencies).toEqual([]);
  });
});

describe("#275 catalogue de métriques", () => {
  const catalog = listMetrics();

  it("porte une version", () => {
    expect(METRIC_CATALOG_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/);
  });

  it("n'a aucun identifiant en double", () => {
    const ids = catalog.map((metric) => metric.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("chaque métrique porte définition, formule, sources et limites", () => {
    for (const metric of catalog) {
      expect(metric.definition.length).toBeGreaterThan(20);
      expect(metric.formula.length).toBeGreaterThan(5);
      expect(metric.label.length).toBeGreaterThan(2);
      expect(Array.isArray(metric.sources)).toBe(true);
      expect(Array.isArray(metric.limitations)).toBe(true);
    }
  });

  it("chaque métrique disponible cite au moins une source autoritaire", () => {
    for (const metric of catalog.filter((m) => m.availability === "available")) {
      expect(metric.sources.length).toBeGreaterThan(0);
    }
  });

  it("chaque métrique différée explique ce qui bloque", () => {
    const deferred = listDeferredMetrics();
    expect(deferred.length).toBeGreaterThan(0);
    for (const metric of deferred) {
      expect(metric.formula).toBe("Indisponible.");
      expect(metric.limitations.join(" ")).toMatch(/[Bb]loquant/);
    }
  });

  it("aucune métrique n'emploie le terme « chiffre d'affaires » comme libellé", () => {
    for (const metric of catalog) {
      expect(metric.label.toLowerCase()).not.toContain("chiffre d'affaires");
    }
  });

  it("le facturé net porte l'avertissement de non-substitution comptable", () => {
    const metric = getMetric("invoicing.net.amount_ht");
    expect(metric?.limitations.join(" ")).toContain("ne remplace pas les états comptables");
  });

  it("la marge par client et l'OTIF et le DSO sont différés, pas approximés", () => {
    for (const id of ["clients.margin", "deliveries.otif_rate", "cash.dso"]) {
      expect(getMetric(id)?.availability).toBe("deferred");
    }
  });

  it("le délai de décision des devis est différé faute d'historisation", () => {
    const metric = getMetric("quotes.decision_lead_time");
    expect(metric?.availability).toBe("deferred");
    expect(metric?.limitations.join(" ")).toContain("devis_historique");
  });

  it("l'encours déclare la stricte antériorité à la date d'arrêté", () => {
    expect(getMetric("receivables.open.amount_ttc")?.as_of).toContain("STRICT");
  });

  it("la TVA est déclarée non fiscale", () => {
    expect(getMetric("invoicing.tax.amount")?.limitations.join(" ")).toContain("PAS une donnée fiscale");
  });

  it("le trop-perçu documente le masquage historique par GREATEST", () => {
    expect(getMetric("receivables.credit_balance.amount_ttc")?.limitations.join(" ")).toContain(
      "GREATEST"
    );
  });

  it("chaque famille est représentée", () => {
    for (const family of [
      "devis",
      "commandes",
      "livraisons",
      "facturation",
      "encaissement",
      "clients",
      "qualite_donnees",
    ] as const) {
      expect(listMetricsByFamily(family).length).toBeGreaterThan(0);
    }
  });

  it("un identifiant inconnu n'est pas reconnu", () => {
    expect(isKnownMetric("invoicing.chiffre_affaires")).toBe(false);
    expect(isKnownMetric("invoicing.net.amount_ht")).toBe(true);
  });

  it("toutes les métriques disponibles déclarent le fuseau Europe/Paris", () => {
    for (const metric of catalog) expect(metric.timezone).toBe("Europe/Paris");
  });
});

describe("#275 marge", () => {
  it("est déclarée indisponible, jamais nulle", () => {
    expect(MARGIN_UNAVAILABLE.available).toBe(false);
    expect(MARGIN_UNAVAILABLE.reason_code).toBe("CROSS_OBJECT_MARGIN_AGGREGATION_NOT_VALIDATED");
    expect(MARGIN_UNAVAILABLE.message).toContain("Marge client indisponible");
  });

  it("énumère les réconciliations manquantes du reporting client", () => {
    for (const input of [
      "allocation_objet_vers_client",
      "allocation_frais_indirects",
      "traitement_retours_et_avoirs",
      "reconciliation_facture_objet_marge",
    ]) {
      expect(MARGIN_UNAVAILABLE.missing_inputs).toContain(input);
    }
  });
});

describe("#275 capacités", () => {
  it("déclare les quatre capacités de reporting", () => {
    expect([...REPORTING_CAPABILITIES]).toEqual([
      "reporting_read",
      "reporting_financial",
      "reporting_client_detail",
      "reporting_export",
    ]);
  });

  it("un rôle inconnu n'a aucune capacité (refus par défaut)", () => {
    const permissions = resolvePermissions("Operateur");
    expect(Object.values(permissions).every((granted) => granted === false)).toBe(true);
  });

  it("un rôle vide ou nul n'a aucune capacité", () => {
    expect(Object.values(resolvePermissions("")).some(Boolean)).toBe(false);
    expect(Object.values(resolvePermissions(null)).some(Boolean)).toBe(false);
    expect(Object.values(resolvePermissions(undefined)).some(Boolean)).toBe(false);
  });

  it("la Secrétaire lit le reporting mais pas la position financière ni les clients", () => {
    const permissions = resolvePermissions("Secretaire");
    expect(permissions.reporting_read).toBe(true);
    expect(permissions.reporting_financial).toBe(false);
    expect(permissions.reporting_client_detail).toBe(false);
    expect(permissions.reporting_export).toBe(false);
  });

  it("la Comptabilité a les quatre capacités", () => {
    const permissions = resolvePermissions("Comptabilite");
    expect(Object.values(permissions).every(Boolean)).toBe(true);
  });

  it("le Directeur a les quatre capacités", () => {
    expect(Object.values(resolvePermissions("Directeur")).every(Boolean)).toBe(true);
  });

  it("l'Administrateur système conserve son passe-droit global", () => {
    expect(Object.values(resolvePermissions("Administrateur Systeme et Reseau")).every(Boolean)).toBe(true);
  });

  it("la correspondance de rôle est exacte, pas approchée", () => {
    expect(roleHasFinanceCapability("comptabilite", "reporting_financial")).toBe(false);
    expect(roleHasFinanceCapability("Comptabilite ", "reporting_financial")).toBe(true);
  });
});

describe("#275 conversions monétaires et ratios", () => {
  it("convertit une somme NUMERIC rendue en texte", () => {
    expect(money("1234.56")).toBe(1234.56);
  });

  it("traite l'absence comme zéro sans casser", () => {
    expect(money(null)).toBe(0);
    expect(money(undefined)).toBe(0);
  });

  it("préserve un montant négatif (avoir supérieur aux factures)", () => {
    expect(money("-980.10")).toBe(-980.1);
  });

  it("un ratio à dénominateur nul est null, jamais zéro", () => {
    expect(ratio(10, 0)).toBeNull();
  });

  it("un ratio à dénominateur négatif est null", () => {
    expect(ratio(10, -5)).toBeNull();
  });

  it("un ratio normal est calculé", () => {
    expect(ratio(3, 4)).toBe(0.75);
  });

  it("les compteurs restent entiers", () => {
    expect(count("42")).toBe(42);
    expect(count(null)).toBe(0);
  });
});

describe("#275 écarts de comparaison", () => {
  it("calcule un écart absolu et relatif", () => {
    expect(delta(120, 100)).toEqual({ previous: 100, absolute: 20, relative: 0.2 });
  });

  it("un écart sur base nulle n'a pas de pourcentage", () => {
    expect(delta(120, 0).relative).toBeNull();
  });

  it("un écart sur base négative n'a pas de pourcentage", () => {
    expect(delta(50, -100).relative).toBeNull();
  });

  it("arrondit l'écart au centime", () => {
    expect(delta(10.005, 10).absolute).toBe(0.01);
  });

  it("un recul est négatif", () => {
    expect(delta(80, 100).absolute).toBe(-20);
  });
});

describe("#275 balance âgée", () => {
  it("compte cinq tranches", () => {
    expect(AGING_BUCKETS).toHaveLength(5);
  });

  it("les tranches sont disjointes et exhaustives sur 1..∞", () => {
    const bounded = AGING_BUCKETS.filter((bucket) => bucket.min !== null && bucket.max !== null);
    for (let i = 1; i < bounded.length; i += 1) {
      expect(bounded[i].min).toBe((bounded[i - 1].max as number) + 1);
    }
    expect(AGING_BUCKETS[0].key).toBe("not_due");
    expect(AGING_BUCKETS[AGING_BUCKETS.length - 1].max).toBeNull();
  });

  it("porte un libellé lisible pour chaque tranche", () => {
    for (const bucket of AGING_BUCKETS) expect(bucket.label.length).toBeGreaterThan(3);
  });
});
