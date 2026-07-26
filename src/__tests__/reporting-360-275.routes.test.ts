// Reporting commercial 360 (#275) — surface HTTP.
// Refus par défaut, cloisonnement des capacités, enveloppe complète, export gouverné,
// non-fuite de données personnelles, bornes de requête.

import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  currentRole: { value: "Comptabilite" as string | null },
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; username: string; email: string; role: string } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    if (mocks.currentRole.value === null) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    req.user = {
      id: 7,
      username: "tester",
      email: "tester@example.test",
      role: mocks.currentRole.value,
    };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

const BASE = "/api/v1/reporting/commercial/v2";
const LEGACY = "/api/v1/reporting/commercial";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.currentRole.value = "Comptabilite";
  mocks.poolQuery.mockResolvedValue({ rows: [] });
});

const READ_ONLY_ROUTES = [
  "/overview",
  "/quotes",
  "/orders",
  "/deliveries",
  "/definitions",
] as const;
const FINANCIAL_ROUTES = ["/invoicing", "/receivables"] as const;

describe("#275 authentification", () => {
  it("refuse un appel non authentifié", async () => {
    mocks.currentRole.value = null;
    const res = await request(app).get(`${BASE}/overview`);
    expect(res.status).toBe(401);
  });
});

describe("#275 RBAC — refus par défaut", () => {
  for (const route of [...READ_ONLY_ROUTES, ...FINANCIAL_ROUTES, "/clients", "/drilldown", "/export"]) {
    it(`refuse ${route} à un rôle sans capacité Finance`, async () => {
      mocks.currentRole.value = "Operateur";
      const res = await request(app).get(`${BASE}${route}`).query({ entity: "quotes", section: "overview" });
      expect(res.status).toBe(403);
      expect(res.body?.code ?? res.body?.error).toBeTruthy();
    });
  }

  for (const route of READ_ONLY_ROUTES) {
    it(`autorise ${route} à la Secrétaire`, async () => {
      mocks.currentRole.value = "Secretaire";
      const res = await request(app).get(`${BASE}${route}`);
      expect(res.status).toBe(200);
    });
  }

  for (const route of FINANCIAL_ROUTES) {
    it(`refuse ${route} à la Secrétaire (données financières)`, async () => {
      mocks.currentRole.value = "Secretaire";
      const res = await request(app).get(`${BASE}${route}`);
      expect(res.status).toBe(403);
    });
  }

  it("refuse le détail client à la Secrétaire", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${BASE}/clients`);
    expect(res.status).toBe(403);
  });

  it("refuse l'export à la Secrétaire", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${BASE}/export`).query({ section: "quotes" });
    expect(res.status).toBe(403);
  });

  it("autorise les six sections à la Comptabilité", async () => {
    for (const route of [...READ_ONLY_ROUTES, ...FINANCIAL_ROUTES, "/clients"]) {
      const res = await request(app).get(`${BASE}${route}`);
      expect(res.status).toBe(200);
    }
  });

  it("autorise tout au Directeur", async () => {
    mocks.currentRole.value = "Directeur";
    const res = await request(app).get(`${BASE}/receivables`);
    expect(res.status).toBe(200);
  });
});

describe("#275 synthèse — cloisonnement des blocs", () => {
  it("masque facturation, encours et clients pour la Secrétaire", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${BASE}/overview`);
    expect(res.status).toBe(200);
    expect(res.body.data.invoicing).toBeNull();
    expect(res.body.data.receivables).toBeNull();
    expect(res.body.data.clients).toBeNull();
    expect(res.body.data.quotes).not.toBeNull();
    expect(res.body.data.orders).not.toBeNull();
    expect(res.body.data.deliveries).not.toBeNull();
  });

  it("explique pourquoi un bloc est masqué au lieu de l'effacer en silence", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${BASE}/overview`);
    const notes: string[] = res.body.envelope.coverage.notes;
    expect(notes.join(" ")).toContain("reporting_financial");
    expect(notes.join(" ")).toContain("reporting_client_detail");
  });

  it("expose les blocs financiers à la Comptabilité", async () => {
    const res = await request(app).get(`${BASE}/overview`);
    expect(res.body.data.invoicing).not.toBeNull();
    expect(res.body.data.receivables).not.toBeNull();
    expect(res.body.data.clients).not.toBeNull();
  });

  it("ne renvoie jamais une marge chiffrée", async () => {
    const res = await request(app).get(`${BASE}/overview`);
    expect(res.body.data.margin.available).toBe(false);
    expect(res.body.data.margin.message).toContain("Marge réelle indisponible");
    expect(typeof res.body.data.margin.value).toBe("undefined");
  });
});

describe("#275 enveloppe de réponse", () => {
  it("porte les seize informations de provenance", async () => {
    const res = await request(app).get(`${BASE}/overview`);
    const envelope = res.body.envelope;
    for (const key of [
      "as_of",
      "period",
      "comparison",
      "date_basis",
      "timezone",
      "granularity",
      "currency",
      "filters",
      "grain",
      "freshness",
      "catalog_version",
      "metrics",
      "coverage",
      "anomalies",
      "truncation",
      "permissions",
    ]) {
      expect(envelope).toHaveProperty(key);
    }
  });

  it("déclare le fuseau Europe/Paris", async () => {
    const res = await request(app).get(`${BASE}/overview`);
    expect(res.body.envelope.timezone).toBe("Europe/Paris");
  });

  it("porte l'avertissement de non-substitution comptable", async () => {
    const res = await request(app).get(`${BASE}/invoicing`);
    expect(res.body.envelope.disclaimer).toContain("ne remplacent pas les états comptables");
  });

  it("porte la version du catalogue de métriques", async () => {
    const res = await request(app).get(`${BASE}/overview`);
    expect(res.body.envelope.catalog_version).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/);
  });

  it("liste les identifiants de métriques utilisés", async () => {
    const res = await request(app).get(`${BASE}/receivables`);
    expect(res.body.envelope.metrics).toContain("receivables.open.amount_ttc");
  });

  it("reflète les permissions réelles de l'appelant", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${BASE}/overview`);
    expect(res.body.envelope.permissions).toEqual({
      reporting_read: true,
      reporting_financial: false,
      reporting_client_detail: false,
      reporting_export: false,
    });
  });

  it("annonce une fraîcheur temps réel", async () => {
    const res = await request(app).get(`${BASE}/overview`);
    expect(res.body.envelope.freshness.source).toBe("live");
    expect(res.body.envelope.freshness.stale).toBe(false);
    expect(res.body.envelope.freshness.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reprend les filtres appliqués", async () => {
    const res = await request(app).get(`${BASE}/quotes`).query({ client_id: "001", limit: 25 });
    expect(res.body.envelope.filters.client_id).toBe("001");
    expect(res.body.envelope.filters.limit).toBe(25);
  });

  it("interdit la mise en cache par un intermédiaire", async () => {
    const res = await request(app).get(`${BASE}/receivables`);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["cache-control"]).toContain("private");
  });
});

describe("#275 période et comparaison, calculées par le serveur", () => {
  it("résout un préréglage en bornes explicites", async () => {
    const res = await request(app).get(`${BASE}/quotes`).query({ period: "current_year" });
    expect(res.body.envelope.period.from).toMatch(/^\d{4}-01-01$/);
    expect(res.body.envelope.period.to).toMatch(/^\d{4}-12-31$/);
  });

  it("accepte une période personnalisée", async () => {
    const res = await request(app)
      .get(`${BASE}/quotes`)
      .query({ period: "custom", from: "2026-03-01", to: "2026-03-31" });
    expect(res.body.envelope.period).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
  });

  it("refuse une période personnalisée inversée", async () => {
    const res = await request(app)
      .get(`${BASE}/quotes`)
      .query({ period: "custom", from: "2026-05-01", to: "2026-04-01" });
    expect(res.status).toBe(400);
  });

  it("refuse une date malformée", async () => {
    const res = await request(app).get(`${BASE}/quotes`).query({ as_of: "26/07/2026" });
    expect(res.status).toBe(400);
  });

  it("refuse une date inexistante", async () => {
    const res = await request(app).get(`${BASE}/quotes`).query({ as_of: "2026-02-31" });
    expect(res.status).toBe(400);
  });

  it("refuse une date d'arrêté antérieure au début de période", async () => {
    const res = await request(app)
      .get(`${BASE}/receivables`)
      .query({ period: "custom", from: "2026-05-01", to: "2026-05-31", as_of: "2026-01-01" });
    expect(res.status).toBe(400);
  });

  it("refuse une granularité qui produirait trop de points", async () => {
    const res = await request(app)
      .get(`${BASE}/invoicing`)
      .query({ period: "custom", from: "2010-01-01", to: "2026-12-31", granularity: "day" });
    expect(res.status).toBe(400);
    expect(res.body?.code ?? "").toContain("GRANULARITY");
  });

  it("expose la période comparative retenue", async () => {
    const res = await request(app)
      .get(`${BASE}/quotes`)
      .query({ period: "custom", from: "2026-07-01", to: "2026-07-31", compare: "previous_period" });
    expect(res.body.envelope.comparison).toMatchObject({
      mode: "previous_period",
      from: "2026-06-01",
      to: "2026-06-30",
    });
  });

  it("sait ne pas comparer", async () => {
    const res = await request(app).get(`${BASE}/quotes`).query({ compare: "none" });
    expect(res.body.envelope.comparison).toBeNull();
    expect(res.body.comparison).toBeNull();
  });

  it("calcule l'écart côté serveur", async () => {
    const res = await request(app).get(`${BASE}/quotes`).query({ compare: "previous_year" });
    expect(res.body.comparison).toHaveProperty("issued_count");
    expect(res.body.comparison.issued_count).toHaveProperty("relative");
  });

  it("refuse une granularité inconnue", async () => {
    const res = await request(app).get(`${BASE}/quotes`).query({ granularity: "fortnight" });
    expect(res.status).toBe(400);
  });

  it("refuse un préréglage de période inconnu", async () => {
    const res = await request(app).get(`${BASE}/quotes`).query({ period: "since_forever" });
    expect(res.status).toBe(400);
  });

  it("refuse une devise hors ISO 4217", async () => {
    const res = await request(app).get(`${BASE}/invoicing`).query({ currency: "EUROS" });
    expect(res.status).toBe(400);
  });

  it("refuse une limite hors bornes", async () => {
    const res = await request(app).get(`${BASE}/clients`).query({ limit: 5000 });
    expect(res.status).toBe(400);
  });
});

describe("#275 drill-down", () => {
  it("refuse une entité inconnue", async () => {
    const res = await request(app).get(`${BASE}/drilldown`).query({ entity: "salaires" });
    expect(res.status).toBe(400);
  });

  it("refuse le drill-down sur les factures à la Secrétaire", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${BASE}/drilldown`).query({ entity: "invoices" });
    expect(res.status).toBe(403);
  });

  it("refuse le drill-down sur les clients à la Secrétaire", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${BASE}/drilldown`).query({ entity: "clients" });
    expect(res.status).toBe(403);
  });

  it("autorise le drill-down devis à la Secrétaire", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${BASE}/drilldown`).query({ entity: "quotes" });
    expect(res.status).toBe(200);
  });

  it("renvoie l'entité et le périmètre demandés", async () => {
    const res = await request(app)
      .get(`${BASE}/drilldown`)
      .query({ entity: "order_lines", scope: "late" });
    expect(res.body.data.entity).toBe("order_lines");
    expect(res.body.data.scope).toBe("late");
  });

  it("annonce la troncature dans l'enveloppe", async () => {
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM devis d") && sql.includes("COUNT(*) OVER ()")) {
        return Promise.resolve({
          rows: [{ id: "1", numero: "D-1", total_ht: "10.00", total_rows: 400 }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get(`${BASE}/drilldown`).query({ entity: "quotes" });
    expect(res.body.data.truncated).toBe(true);
    expect(res.body.envelope.truncation).toEqual([{ block: "quotes", returned: 1, total: 400 }]);
  });
});

describe("#275 export gouverné", () => {
  it("refuse une section inconnue", async () => {
    const res = await request(app).get(`${BASE}/export`).query({ section: "salaires" });
    expect(res.status).toBe(400);
  });

  it("refuse un format non pris en charge", async () => {
    const res = await request(app).get(`${BASE}/export`).query({ section: "quotes", format: "xlsx" });
    expect(res.status).toBe(400);
  });

  it("refuse explicitement l'export des coordonnées client", async () => {
    const res = await request(app)
      .get(`${BASE}/export`)
      .query({ section: "clients", include_client_contacts: "true" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("RGPD");
  });

  it("produit un CSV avec en-tête de provenance", async () => {
    const res = await request(app).get(`${BASE}/export`).query({ section: "quotes" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("# Version du catalogue");
    expect(res.text).toContain("# Période");
    expect(res.text).toContain("# Date d'arrêté");
    expect(res.text).toContain("# Base de date");
    expect(res.text).toContain("# Fuseau");
    expect(res.text).toContain("# Devises");
    expect(res.text).toContain("# Filtres");
    expect(res.text).toContain("# Généré le");
    expect(res.text).toContain("# Auteur");
    expect(res.text).toContain("# Avertissement");
  });

  it("porte l'empreinte SHA-256 du contenu", async () => {
    const res = await request(app).get(`${BASE}/export`).query({ section: "quotes" });
    expect(res.headers["x-cerp-export-checksum"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("nomme le fichier avec la période", async () => {
    const res = await request(app)
      .get(`${BASE}/export`)
      .query({ section: "quotes", period: "custom", from: "2026-01-01", to: "2026-03-31" });
    expect(res.headers["content-disposition"]).toContain("2026-01-01_2026-03-31.csv");
  });

  it("identifie l'auteur de l'extraction", async () => {
    const res = await request(app).get(`${BASE}/export`).query({ section: "quotes" });
    expect(res.text).toContain("tester (#7)");
  });

  it("refuse l'export d'une section financière sans la capacité correspondante", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${BASE}/export`).query({ section: "receivables" });
    expect(res.status).toBe(403);
  });

  it("n'expose aucune coordonnée personnelle dans le CSV clients", async () => {
    mocks.poolQuery.mockImplementation(() =>
      Promise.resolve({
        rows: [
          {
            client_count: 1,
            net_ht_total: "1000.00",
            top5_ht: "1000.00",
            top10_ht: "1000.00",
            items: [
              {
                rn: 1,
                client_id: "001",
                company_name: "ACME",
                net_ht: "1000.00",
                net_ttc: "1200.00",
                invoice_count: 1,
                credit_count: 0,
                open_ttc: "0.00",
                overdue_ttc: "0.00",
              },
            ],
          },
        ],
      })
    );
    const res = await request(app).get(`${BASE}/export`).query({ section: "clients" });
    expect(res.status).toBe(200);

    // Les lignes `#` sont l'en-tête de provenance (elle mentionne justement la règle
    // de minimisation). La vérification porte sur les DONNÉES exportées.
    const body = res.text
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("﻿#") && !line.startsWith("#"))
      .join("\n")
      .toLowerCase();

    expect(body).not.toMatch(/@/);
    for (const forbidden of ["telephone", "téléphone", "adresse", "contact", "email", "e-mail", "siret"]) {
      expect(body).not.toContain(forbidden);
    }
    // …et la règle de minimisation est bien annoncée dans l'en-tête.
    expect(res.text).toContain("Aucune coordonnée personnelle");
  });

  it("échappe correctement le séparateur CSV", async () => {
    mocks.poolQuery.mockImplementation(() =>
      Promise.resolve({
        rows: [
          {
            client_count: 1,
            net_ht_total: "1000.00",
            top5_ht: "1000.00",
            top10_ht: "1000.00",
            items: [{ rn: 1, client_id: "001", company_name: "A; B", net_ht: "1000.00" }],
          },
        ],
      })
    );
    const res = await request(app).get(`${BASE}/export`).query({ section: "clients" });
    expect(res.text).toContain('"A; B"');
  });
});

describe("#275 définitions", () => {
  it("expose le catalogue complet", async () => {
    const res = await request(app).get(`${BASE}/definitions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.metrics)).toBe(true);
    expect(res.body.data.metrics.length).toBeGreaterThan(20);
  });

  it("liste les métriques différées", async () => {
    const res = await request(app).get(`${BASE}/definitions`);
    expect(res.body.data.deferred).toContain("cash.dso");
    expect(res.body.data.deferred).toContain("deliveries.otif_rate");
    expect(res.body.data.deferred).toContain("clients.margin");
  });

  it("déclare la marge indisponible", async () => {
    const res = await request(app).get(`${BASE}/definitions`);
    expect(res.body.data.margin.available).toBe(false);
  });

  it("est lisible par la Secrétaire", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${BASE}/definitions`);
    expect(res.status).toBe(200);
  });
});

describe("#275 anti-IDOR et non-fuite", () => {
  it("un client_id inconnu ne fait pas fuiter d'autres clients", async () => {
    const res = await request(app).get(`${BASE}/clients`).query({ client_id: "INEXISTANT" });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it("le filtre client est transmis en paramètre lié", async () => {
    await request(app).get(`${BASE}/receivables`).query({ client_id: "0' OR '1'='1" });
    const calls = mocks.poolQuery.mock.calls as Array<[string, unknown[]]>;
    expect(calls.some(([, values]) => values?.includes("0' OR '1'='1"))).toBe(true);
    expect(calls.every(([sql]) => !sql.includes("OR '1'='1"))).toBe(true);
  });

  it("aucune réponse ne contient de champ de contact", async () => {
    const res = await request(app).get(`${BASE}/overview`);
    const body = JSON.stringify(res.body);
    for (const field of ['"email"', '"phone"', '"observations"', '"siret"']) {
      expect(body).not.toContain(field);
    }
  });

  it("une erreur de base ne renvoie pas le SQL au client", async () => {
    mocks.poolQuery.mockRejectedValue(
      Object.assign(new Error("syntax error at or near SELECT total_ttc FROM facture"), {
        code: "42601",
      })
    );
    const res = await request(app).get(`${BASE}/receivables`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain("FROM facture");
  });
});

describe("#275 endpoints historiques préservés", () => {
  it("l'encours historique répond toujours", async () => {
    const res = await request(app).get(`${LEGACY}/outstanding`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("outstanding_ttc");
    expect(res.body).toHaveProperty("overdue_invoices");
  });

  it("le facturé historique répond toujours", async () => {
    const res = await request(app).get(`${LEGACY}/revenue`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("buckets");
  });

  it("le top clients historique répond toujours", async () => {
    const res = await request(app).get(`${LEGACY}/top-clients`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
  });

  it("les endpoints historiques restent ouverts à reporting_read", async () => {
    mocks.currentRole.value = "Secretaire";
    const res = await request(app).get(`${LEGACY}/outstanding`);
    expect(res.status).toBe(200);
  });

  it("les endpoints historiques refusent un rôle sans capacité", async () => {
    mocks.currentRole.value = "Operateur";
    const res = await request(app).get(`${LEGACY}/outstanding`);
    expect(res.status).toBe(403);
  });

  it("l'encours historique expose désormais la date d'arrêté retenue", async () => {
    const res = await request(app).get(`${LEGACY}/outstanding`).query({ as_of: "2026-06-30" });
    expect(res.body.as_of).toBe("2026-06-30");
  });
});

describe("#275 robustesse", () => {
  it("une section en erreur n'empêche pas les autres routes de répondre", async () => {
    let call = 0;
    mocks.poolQuery.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve({ rows: [] });
    });
    const failing = await request(app).get(`${BASE}/receivables`);
    expect(failing.status).toBeGreaterThanOrEqual(400);

    mocks.poolQuery.mockResolvedValue({ rows: [] });
    const healthy = await request(app).get(`${BASE}/quotes`);
    expect(healthy.status).toBe(200);
  });

  it("une base vide renvoie des zéros explicites et des ratios nuls", async () => {
    const res = await request(app).get(`${BASE}/quotes`);
    expect(res.body.data.issued_count).toBe(0);
    expect(res.body.data.decision_rate).toBeNull();
    expect(res.body.data.win_rate).toBeNull();
  });

  it("la balance âgée renvoie ses cinq tranches même à vide", async () => {
    const res = await request(app).get(`${BASE}/receivables`);
    expect(res.body.data.aging).toHaveLength(5);
    expect(res.body.data.aging.every((bucket: { amount_ttc: number }) => bucket.amount_ttc === 0)).toBe(true);
  });
});
