// Reporting commercial 360 (#275) — contrat SQL.
//
// Deux rôles :
//   1. Vérifier, sans base, les propriétés structurantes de chaque requête générée :
//      stricte antériorité à `as_of`, périmètre de statuts, absence d'écrêtage
//      masquant, agrégation NUMERIC, paramètres liés (jamais d'interpolation).
//   2. Écrire un dump SQL à paramètres littéraux, rejoué ensuite contre un vrai
//      PostgreSQL dans une transaction annulée (voir la section « Réconciliation »
//      du rapport #275).

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { ensureTmpStoragePath } from "../utils/cerpStorage";

const captured: Array<{ sql: string; values: unknown[] }> = [];

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
}));

vi.mock("pg", () => {
  const pool = { on: vi.fn(), query: mocks.poolQuery, connect: vi.fn() };
  return { Pool: vi.fn(() => pool) };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

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
  type ReportingContext,
} from "../module/facturation/repository/reporting-v2.repository";
import {
  repoCommercialOutstanding,
  repoCommercialRevenue,
  repoCommercialTopClients,
} from "../module/facturation/repository/reporting.repository";

const CTX: ReportingContext = {
  period: { from: "2026-01-01", to: "2026-12-31" },
  asOf: "2026-06-30",
  basis: "document_date",
  granularity: "month",
  limit: 10,
};

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockImplementation((sql: string, values: unknown[] = []) => {
    captured.push({ sql, values });
    return Promise.resolve({ rows: [] });
  });
});

function lastQueries(n = 1) {
  return captured.slice(-n);
}

function allSql(): string {
  return captured.map((entry) => entry.sql).join("\n");
}

describe("#275 encours — stricte antériorité à la date d'arrêté", () => {
  it("borne les règlements sur date_paiement", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    const sql = allSql();
    expect(sql).toContain("p.date_paiement <=");
  });

  it("borne aussi la date d'imputation du règlement", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    expect(allSql()).toContain("(pa.created_at AT TIME ZONE 'Europe/Paris')::date <=");
  });

  it("borne les avoirs sur leur date de registre", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    expect(allSql()).toContain("(asa.created_at AT TIME ZONE 'Europe/Paris')::date <=");
  });

  it("passe la date d'arrêté en paramètre lié, jamais en littéral", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    for (const entry of captured) {
      expect(entry.sql).not.toContain("'2026-06-30'");
    }
    expect(captured.some((entry) => entry.values.includes("2026-06-30"))).toBe(true);
  });

  it("n'écrête pas le solde à zéro dans le calcul (le trop-perçu doit rester visible)", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    const sql = allSql();
    expect(sql).toContain("AS balance_ttc");
    expect(sql).not.toMatch(/GREATEST\(0,\s*lf\.total_ttc/);
  });

  it("isole explicitement les soldes créditeurs", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    expect(allSql()).toContain("b.balance_ttc < 0");
  });

  it("exclut les règlements rejetés, extournés et les contre-écritures", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    const sql = allSql();
    expect(sql).toContain("workflow_status <> 'REVERSED'");
    expect(sql).toContain("reversal_of_id IS NULL");
    expect(captured.some((entry) => entry.values.some((v) => Array.isArray(v) && v.includes("REJECTED")))).toBe(
      true
    );
  });

  it("réunit les allocations #227 et le rattachement direct hérité sans double comptage", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    const sql = allSql();
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM paiement_allocations pa2");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM avoir_source_allocations asa2");
  });

  it("compte le solde d'un règlement partiellement affecté dans le KPI non affecté", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    const sql = allSql();
    expect(sql).toContain("p.montant::numeric(18,2) - (CASE");
    expect(sql).toContain("SELECT SUM(pa.amount_ttc)");
    expect(sql).toContain("SUM(available)");
  });

  it("neutralise dans ce KPI la preuve directe héritée, économiquement déjà affectée", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    const sql = allSql();
    expect(sql).toMatch(/WHEN p\.facture_id IS NOT NULL[\s\S]*NOT EXISTS[\s\S]*THEN p\.montant::numeric\(18,2\)/);
    expect(sql).toContain("p.status NOT IN ('REJECTED', 'REVERSED')");
  });

  it("agrège en NUMERIC et jamais en float8", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    expect(allSql()).not.toContain("float8");
    expect(allSql()).toContain("numeric(18,2)");
  });

  it("compare l'échéance strictement à la date d'arrêté", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    expect(allSql()).toMatch(/due_date <\s*\$\d+::date/);
  });

  it("produit les cinq tranches d'ancienneté", async () => {
    captured.length = 0;
    await repoReceivables(CTX);
    const sql = allSql();
    for (const key of ["not_due", "d1_30", "d31_60", "d61_90", "d90_plus"]) {
      expect(sql).toContain(key);
    }
  });

  it("renvoie toujours les cinq tranches, même sans donnée", async () => {
    captured.length = 0;
    const result = await repoReceivables(CTX);
    expect(result.aging.map((bucket) => bucket.key)).toEqual([
      "not_due",
      "d1_30",
      "d31_60",
      "d61_90",
      "d90_plus",
    ]);
  });
});

describe("#275 registre — périmètre de statuts", () => {
  it("le registre des factures exclut brouillons, validations et annulations", async () => {
    captured.length = 0;
    await repoInvoicing(CTX);
    const statusArrays = captured
      .flatMap((entry) => entry.values)
      .filter((value): value is string[] => Array.isArray(value) && value.includes("ISSUED"));
    expect(statusArrays.length).toBeGreaterThan(0);
    for (const array of statusArrays) {
      expect(array).not.toContain("DRAFT");
      expect(array).not.toContain("CANCELLED");
      expect(array).not.toContain("brouillon");
      expect(array).not.toContain("annulee");
    }
  });

  it("le registre des factures inclut l'héritage minuscule", async () => {
    captured.length = 0;
    await repoInvoicing(CTX);
    const array = captured
      .flatMap((entry) => entry.values)
      .find((value): value is string[] => Array.isArray(value) && value.includes("PARTIALLY_PAID"));
    expect(array).toContain("emise");
    expect(array).toContain("partielle");
  });

  it("le filtre historique <> 'brouillon' a disparu", async () => {
    captured.length = 0;
    await repoInvoicing(CTX);
    await repoReceivables(CTX);
    expect(allSql()).not.toContain("<> 'brouillon'");
  });

  it("compte séparément les pièces hors registre au lieu de les additionner", async () => {
    captured.length = 0;
    await repoInvoicing(CTX);
    const sql = allSql();
    expect(sql).toContain("AS draft_count");
    expect(sql).toContain("AS cancelled_count");
  });
});

describe("#275 carnet de commandes", () => {
  it("repose sur les quantités de lignes, pas sur un statut d'en-tête", async () => {
    captured.length = 0;
    await repoOrders(CTX);
    const sql = allSql();
    expect(sql).toContain("cl.quantite - COALESCE(sl.quantite_expediee, 0)");
    expect(sql).not.toContain("cc.statut");
  });

  it("ne retient que les BL expédiés ou livrés, comme la vue reliquats", async () => {
    captured.length = 0;
    await repoOrders(CTX);
    expect(
      captured.some((entry) =>
        entry.values.some((value) => Array.isArray(value) && value.join() === "SHIPPED,DELIVERED")
      )
    ).toBe(true);
  });

  it("borne les expéditions à la date d'arrêté", async () => {
    captured.length = 0;
    await repoOrders(CTX);
    expect(allSql()).toContain("COALESCE(bl.date_expedition, bl.date_livraison, bl.date_creation) <=");
  });

  it("sort les commandes internes du montant commercial", async () => {
    captured.length = 0;
    await repoOrders(CTX);
    expect(allSql()).toContain("<> 'INTERNE'");
  });

  it("valorise le reste à livrer au prix net de la ligne", async () => {
    captured.length = 0;
    await repoOrders(CTX);
    expect(allSql()).toContain("prix_unitaire_ht");
    expect(allSql()).toContain("remise_ligne");
  });

  it("calcule le reste à facturer sur les allocations de source de facture", async () => {
    captured.length = 0;
    await repoOrders(CTX);
    expect(allSql()).toContain("facture_source_allocations");
    expect(allSql()).toContain("'DELIVERY_LINE'");
  });

  it("ne compte jamais une ligne sans délai comme en retard", async () => {
    captured.length = 0;
    await repoOrders(CTX);
    expect(allSql()).toContain("delai_client IS NOT NULL AND delai_client <");
  });
});

describe("#275 devis", () => {
  it("exclut brouillons et devis annulés de la cohorte", async () => {
    captured.length = 0;
    await repoQuotes(CTX);
    const array = captured
      .flatMap((entry) => entry.values)
      .find((value): value is string[] => Array.isArray(value) && value.includes("BROUILLON"));
    expect(array).toEqual(["BROUILLON", "ANNULE"]);
    expect(allSql()).toContain("d.statut <> ALL(");
  });

  it("le portefeuille ouvert n'est pas borné par la période", async () => {
    captured.length = 0;
    await repoQuotes(CTX);
    const openQuery = lastQueries(1)[0];
    expect(openQuery.sql).toContain("d.statut = 'ENVOYE'");
    expect(openQuery.sql).not.toContain("d.date_creation::date >=");
  });

  it("signale les devis dont la validité est dépassée sans les exclure", async () => {
    captured.length = 0;
    await repoQuotes(CTX);
    expect(allSql()).toContain("d.date_validite IS NOT NULL AND d.date_validite <");
  });

  it("ne calcule aucun pipeline pondéré par probabilité", async () => {
    captured.length = 0;
    await repoQuotes(CTX);
    expect(allSql().toLowerCase()).not.toContain("probabilit");
    expect(allSql()).not.toContain("weighted");
  });

  it("un taux sans dénominateur reste nul et non zéro", async () => {
    captured.length = 0;
    const result = await repoQuotes(CTX);
    expect(result.decision_rate).toBeNull();
    expect(result.win_rate).toBeNull();
  });
});

describe("#275 livraisons", () => {
  it("mesure la ponctualité à la ligne contre le délai client", async () => {
    captured.length = 0;
    await repoDeliveries(CTX);
    expect(allSql()).toContain("date_expedition <= delai_client");
  });

  it("sort les lignes sans délai du dénominateur", async () => {
    captured.length = 0;
    await repoDeliveries(CTX);
    expect(allSql()).toContain("AS undated_lines");
  });

  it("ne valorise pas une ligne de BL sans ligne de commande", async () => {
    captured.length = 0;
    await repoDeliveries(CTX);
    expect(allSql()).toContain("WHEN cl.id IS NULL THEN NULL");
    expect(allSql()).toContain("AS unlinked_lines");
  });

  it("distingue commandes partiellement et totalement livrées", async () => {
    captured.length = 0;
    await repoDeliveries(CTX);
    expect(allSql()).toContain("AS partial_orders");
    expect(allSql()).toContain("AS complete_orders");
  });

  it("ne produit aucun OTIF", async () => {
    captured.length = 0;
    const result = await repoDeliveries(CTX);
    expect(Object.keys(result)).not.toContain("otif_rate");
  });
});

describe("#275 clients", () => {
  it("classe sur le même périmètre que le total", async () => {
    captured.length = 0;
    await repoClients(CTX);
    const sql = allSql();
    expect(sql).toContain("ledger_facture");
    expect(sql).toContain("ledger_avoir");
    expect(sql).toContain("per_client");
  });

  it("n'expose aucune coordonnée personnelle", async () => {
    captured.length = 0;
    await repoClients(CTX);
    const sql = allSql();
    for (const column of ["c.email", "c.phone", "c.observations", "contact_id"]) {
      expect(sql).not.toContain(column);
    }
  });

  it("borne le classement par LIMIT explicite", async () => {
    captured.length = 0;
    await repoClients(CTX);
    expect(allSql()).toContain("r.rn <=");
  });

  it("ne calcule aucune marge par client", async () => {
    captured.length = 0;
    const result = await repoClients(CTX);
    expect(Object.keys(result)).not.toContain("margin");
  });

  it("un poids de concentration sans total est nul", async () => {
    captured.length = 0;
    const result = await repoClients(CTX);
    expect(result.top5_share).toBeNull();
    expect(result.top10_share).toBeNull();
  });
});

describe("#275 qualité de données", () => {
  it("ne remonte que les anomalies réellement présentes", async () => {
    captured.length = 0;
    const anomalies = await repoDataQuality(CTX);
    expect(anomalies).toEqual([]);
  });

  it("interroge les sept familles d'anomalies", async () => {
    captured.length = 0;
    await repoDataQuality(CTX);
    const sql = allSql();
    for (const code of [
      "invoices_without_due_date",
      "invoices_unknown_status",
      "deliveries_without_ship_date",
      "delivery_lines_unlinked",
      "orders_without_lines",
      "quotes_expired_not_requalified",
      "payments_unallocated",
    ]) {
      expect(sql).toContain(code);
    }
  });
});

describe("#275 drill-down", () => {
  const entities = [
    "quotes",
    "orders",
    "order_lines",
    "deliveries",
    "invoices",
    "credit_notes",
    "payments",
    "clients",
  ] as const;

  // Une borne explicite est soit un LIMIT, soit un filtre de rang (`rn <= $n`) :
  // les deux sont des bornes serveur, aucune n'est une troncature côté interface.
  const BOUNDED = /LIMIT \$\d+|rn <= \$\d+/;

  it.each(["all", "outstanding", "overdue", "credit_balance"])(
    "génère des paramètres PostgreSQL contigus pour le drill-down factures (%s)",
    async (scope) => {
      captured.length = 0;
      await repoDrilldown(CTX, "invoices", scope);
      const [{ sql, values }] = lastQueries(1);
      const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      expect(new Set(placeholders)).toEqual(new Set(Array.from({ length: values.length }, (_, index) => index + 1)));
    }
  );

  for (const entity of entities) {
    it(`borne le drill-down « ${entity} » côté serveur`, async () => {
      captured.length = 0;
      await repoDrilldown(CTX, entity, "all");
      expect(allSql()).toMatch(BOUNDED);
    });
  }

  it("annonce la troncature au lieu de la subir", async () => {
    captured.length = 0;
    mocks.poolQuery.mockImplementation((sql: string, values: unknown[] = []) => {
      captured.push({ sql, values });
      return Promise.resolve({
        rows: [
          { id: "1", numero: "F-1", total_ht: "100.00", total_rows: 250 },
          { id: "2", numero: "F-2", total_ht: "90.00", total_rows: 250 },
        ],
      });
    });
    const result = await repoDrilldown(CTX, "quotes", "all");
    expect(result.total).toBe(250);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("ne renvoie pas le compteur technique dans les lignes", async () => {
    captured.length = 0;
    mocks.poolQuery.mockImplementation((sql: string, values: unknown[] = []) => {
      captured.push({ sql, values });
      return Promise.resolve({ rows: [{ id: "1", numero: "F-1", total_ht: "100.00", total_rows: 1 }] });
    });
    const result = await repoDrilldown(CTX, "quotes", "all");
    expect(Object.keys(result.rows[0])).not.toContain("total_rows");
    expect(result.rows[0].total_ht).toBe(100);
  });

  it("un scope « en retard » filtre réellement côté serveur", async () => {
    captured.length = 0;
    await repoDrilldown(CTX, "order_lines", "late");
    expect(allSql()).toContain("cl.delai_client IS NOT NULL AND cl.delai_client <");
  });

  it("un scope « non affecté » filtre le solde disponible et conserve les paiements partiels", async () => {
    captured.length = 0;
    await repoDrilldown(CTX, "payments", "unallocated");
    const sql = allSql();
    expect(sql).toContain("AS allocated_amount");
    expect(sql).toContain("AS available_amount");
    expect(sql).toContain("WHERE pr.available_amount > 0::numeric");
    expect(sql).toContain("SELECT SUM(pa.amount_ttc)");
    expect(sql).not.toContain("p.facture_id IS NULL");
  });

  it("projette le direct legacy en ALLOCATED et l'exclut du drill-down non affecté", async () => {
    captured.length = 0;
    await repoDrilldown(CTX, "payments", "unallocated");
    const sql = allSql();
    expect(sql).toContain("p.facture_id IS NOT NULL");
    expect(sql).toContain("FROM paiement_allocations pa2");
    expect(sql).toContain("THEN 'ALLOCATED'");
    expect(sql).toContain("pr.projected_status AS status");
    expect(sql).toContain("p.status NOT IN ('REJECTED', 'REVERSED')");
  });

  it("expose les montants total, affecté et disponible dans le drill-down", async () => {
    captured.length = 0;
    mocks.poolQuery.mockImplementation((sql: string, values: unknown[] = []) => {
      captured.push({ sql, values });
      return Promise.resolve({
        rows: [{ id: "9", montant: "100.00", allocated_amount: "60.00", available_amount: "40.00", total_rows: 1 }],
      });
    });

    const result = await repoDrilldown(CTX, "payments", "unallocated");
    expect(result.rows[0]).toMatchObject({ montant: 100, allocated_amount: 60, available_amount: 40 });
  });
});

describe("#275 endpoints historiques corrigés", () => {
  it("l'encours historique borne les règlements à la date d'arrêté", async () => {
    captured.length = 0;
    await repoCommercialOutstanding({ as_of: "2026-06-30", limit: 10, include_brouillon: false });
    expect(allSql()).toContain("p.date_paiement <=");
  });

  it("l'encours historique n'utilise plus GREATEST pour masquer un trop-perçu", async () => {
    captured.length = 0;
    await repoCommercialOutstanding({ as_of: "2026-06-30", limit: 10, include_brouillon: false });
    expect(allSql()).not.toMatch(/GREATEST\(0,\s*f\.total_ttc/);
  });

  it("l'encours historique conserve le contrat de sortie attendu par ses consommateurs", async () => {
    captured.length = 0;
    const result = await repoCommercialOutstanding({
      as_of: "2026-06-30",
      limit: 10,
      include_brouillon: false,
    });
    for (const key of [
      "as_of",
      "outstanding_ttc",
      "overdue_ttc",
      "count_outstanding",
      "count_overdue",
      "overdue_invoices",
    ]) {
      expect(result).toHaveProperty(key);
    }
    expect(Array.isArray(result.overdue_invoices)).toBe(true);
  });

  it("l'encours historique expose désormais trop-perçus et non-affectés", async () => {
    captured.length = 0;
    const result = await repoCommercialOutstanding({
      as_of: "2026-06-30",
      limit: 10,
      include_brouillon: false,
    });
    expect(result.credit_balance_ttc).toBe(0);
    expect(result.unallocated_payments_ttc).toBe(0);
    expect(result.unallocated_credits_ttc).toBe(0);
  });

  it("le facturé historique n'agrège plus en float8", async () => {
    captured.length = 0;
    await repoCommercialRevenue({ granularity: "month", include_brouillon: false });
    expect(allSql()).not.toContain("float8");
  });

  it("le facturé historique ne retient que les avoirs finalisés", async () => {
    captured.length = 0;
    await repoCommercialRevenue({ granularity: "month", include_brouillon: false });
    const array = captured
      .flatMap((entry) => entry.values)
      .find((value): value is string[] => Array.isArray(value) && value.includes("emis"));
    expect(array).toContain("ISSUED");
    expect(array).not.toContain("DRAFT");
  });

  it("le top clients partage le périmètre de statuts du facturé", async () => {
    captured.length = 0;
    await repoCommercialTopClients({ limit: 10, include_brouillon: false });
    const array = captured
      .flatMap((entry) => entry.values)
      .find((value): value is string[] => Array.isArray(value) && value.includes("ISSUED"));
    expect(array).toContain("PARTIALLY_PAID");
    expect(array).not.toContain("CANCELLED");
  });

  it("include_brouillon élargit aux pièces en préparation sans jamais inclure une annulation", async () => {
    captured.length = 0;
    await repoCommercialRevenue({ granularity: "month", include_brouillon: true });
    const array = captured
      .flatMap((entry) => entry.values)
      .find((value): value is string[] => Array.isArray(value) && value.includes("DRAFT"));
    expect(array).toContain("brouillon");
    expect(array).not.toContain("CANCELLED");
    expect(array).not.toContain("annulee");
  });
});

describe("#275 paramétrage et bornes", () => {
  it("aucune requête n'interpole une valeur de filtre dans le SQL", async () => {
    captured.length = 0;
    const ctx: ReportingContext = { ...CTX, clientId: "CLI'; DROP TABLE facture; --", currency: "EUR" };
    await repoInvoicing(ctx);
    await repoReceivables(ctx);
    await repoClients(ctx);
    for (const entry of captured) {
      expect(entry.sql).not.toContain("DROP TABLE");
    }
    expect(captured.some((entry) => entry.values.includes("CLI'; DROP TABLE facture; --"))).toBe(true);
  });

  it("chaque requête de liste porte une borne serveur explicite", async () => {
    captured.length = 0;
    await repoQuotes(CTX);
    await repoOrders(CTX);
    await repoReceivables(CTX);
    await repoClients(CTX);
    const listQueries = captured.filter((entry) => entry.sql.includes("json_agg"));
    expect(listQueries.length).toBeGreaterThan(0);
    for (const entry of listQueries) expect(entry.sql).toMatch(/LIMIT \$\d+|rn <= \$\d+/);
  });

  it("la devise est appliquée en filtre serveur quand elle est demandée", async () => {
    captured.length = 0;
    await repoInvoicing({ ...CTX, currency: "USD" });
    expect(allSql()).toContain("UPPER(COALESCE(f.currency, 'EUR')) =");
    expect(captured.some((entry) => entry.values.includes("USD"))).toBe(true);
  });

  it("la liste des devises couvre factures, avoirs et règlements", async () => {
    captured.length = 0;
    await repoCurrencies(CTX);
    const sql = allSql();
    expect(sql).toContain("FROM facture f");
    expect(sql).toContain("FROM avoir a");
    expect(sql).toContain("FROM paiement p2");
  });
});

// ---------------------------------------------------------------------------
// Dump SQL à paramètres littéraux, rejoué contre un vrai PostgreSQL.
// ---------------------------------------------------------------------------

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (Array.isArray(value)) {
    return `ARRAY[${value.map((item) => `'${String(item).replace(/'/g, "''")}'`).join(",")}]`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function inlineParams(sql: string, values: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_match, index: string) => sqlLiteral(values[Number(index) - 1]));
}

afterAll(async () => {
  captured.length = 0;
  mocks.poolQuery.mockImplementation((sql: string, values: unknown[] = []) => {
    captured.push({ sql, values });
    return Promise.resolve({ rows: [] });
  });

  const ctx: ReportingContext = {
    period: { from: "2026-01-01", to: "2026-12-31" },
    asOf: "2026-06-30",
    basis: "document_date",
    granularity: "month",
    limit: 10,
  };

  const sections: Array<[string, () => Promise<unknown>]> = [
    ["quotes", () => repoQuotes(ctx)],
    ["orders", () => repoOrders(ctx)],
    ["deliveries", () => repoDeliveries(ctx)],
    ["invoicing", () => repoInvoicing(ctx)],
    ["receivables", () => repoReceivables(ctx)],
    ["clients", () => repoClients(ctx)],
    ["currencies", () => repoCurrencies(ctx)],
    ["data_quality", () => repoDataQuality(ctx)],
    ["drilldown_invoices", () => repoDrilldown(ctx, "invoices", "overdue")],
    ["drilldown_order_lines", () => repoDrilldown(ctx, "order_lines", "late")],
    ["drilldown_payments", () => repoDrilldown(ctx, "payments", "unallocated")],
    ["drilldown_quotes", () => repoDrilldown(ctx, "quotes", "open")],
    ["drilldown_deliveries", () => repoDrilldown(ctx, "deliveries", "shipped")],
    ["drilldown_credit_notes", () => repoDrilldown(ctx, "credit_notes", "all")],
    ["drilldown_orders", () => repoDrilldown(ctx, "orders", "all")],
    ["legacy_outstanding", () => repoCommercialOutstanding({ as_of: "2026-06-30", limit: 10, include_brouillon: false })],
    ["legacy_revenue", () => repoCommercialRevenue({ granularity: "month", include_brouillon: false })],
    ["legacy_top_clients", () => repoCommercialTopClients({ limit: 10, include_brouillon: false })],
  ];

  const lines: string[] = [
    "-- Généré par src/__tests__/reporting-360-275.sql.test.ts — NE PAS ÉDITER À LA MAIN.",
    "-- Paramètres inlinés pour rejeu psql. Lecture seule.",
    "",
  ];

  for (const [name, run] of sections) {
    const before = captured.length;
    await run();
    const queries = captured.slice(before);
    queries.forEach((entry, index) => {
      lines.push(`\\echo '### ${name}#${index + 1}'`);
      lines.push(`${inlineParams(entry.sql, entry.values).trim()};`);
      lines.push("");
    });
  }

  writeFileSync(
    join(ensureTmpStoragePath("reporting"), "queries.sql"),
    lines.join("\n"),
    "utf8",
  );
});
