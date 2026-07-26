// #142 — Surface HTTP Traçabilité 360 : authentification, RBAC refusé par
// défaut, anti-IDOR, validation stricte, non-fuite de chemin de stockage et
// compatibilité du contrat historique.

import request from "supertest";
import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  currentRole: { value: "administrateur" as string | null },
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };
  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
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
      id: 1,
      username: "tester",
      email: "tester@example.test",
      role: mocks.currentRole.value,
    };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

const BASE = "/api/v1/traceability/v2";
const LEGACY = "/api/v1/traceability";
const LOT_ID = "11111111-1111-4111-8111-111111111111";
const OF_ID = "42";

/**
 * Routeur de requêtes : chaque SQL est reconnu par un fragment distinctif.
 * Tout ce qui n'est pas explicitement reconnu renvoie zéro ligne — le moteur
 * doit rester lisible même quand une source est vide.
 */
function routeQuery(sql: string): { rows: unknown[] } {
  const text = String(sql);
  if (text.includes("FROM public.lots l") && text.includes("l.lot_code AS code")) {
    return {
      rows: [
        {
          id: LOT_ID,
          code: "LOT-2026-0001",
          label: "LOT-2026-0001 — Barre inox",
          status: "AVAILABLE",
          date: "2026-07-01T00:00:00.000Z",
          qty: null,
          unit: "kg",
          meta_article_code: "ART-INOX",
          meta_supplier_lot_code: "SUP-778",
        },
      ],
    };
  }
  if (text.includes("FROM public.ordres_fabrication o") && text.includes("o.numero AS code")) {
    return {
      rows: [
        {
          id: OF_ID,
          code: "OF-2026-0042",
          label: "OF OF-2026-0042",
          status: "EN_COURS",
          date: "2026-07-02T00:00:00.000Z",
          qty: 10,
          unit: null,
          meta_snapshot_sha256: "a".repeat(64),
        },
      ],
    };
  }
  if (text.includes("pg_extension")) return { rows: [] };
  return { rows: [] };
}

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.currentRole.value = "administrateur";

  mocks.poolQuery.mockImplementation(async (sql: string) => routeQuery(sql));
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
});

/* -------------------------------------------------------------------------- */
/* Authentification                                                           */
/* -------------------------------------------------------------------------- */

describe("#142 authentification", () => {
  const routes: Array<[string, string]> = [
    ["get", `${BASE}/capabilities`],
    ["get", `${BASE}/search?q=LOT`],
    ["get", `${BASE}/chain?type=lot&id=${LOT_ID}`],
    ["get", `${BASE}/expand?type=lot&id=${LOT_ID}&direction=upstream`],
    ["get", `${BASE}/impact?type=lot&id=${LOT_ID}`],
    ["get", `${LEGACY}/chain?type=lot&id=${LOT_ID}`],
    ["get", `/api/v1/asbuilt/lots/${LOT_ID}/preview`],
  ];

  for (const [method, url] of routes) {
    it(`refuse ${method.toUpperCase()} ${url} sans authentification`, async () => {
      mocks.currentRole.value = null;
      const res = await (request(app) as never as Record<string, (u: string) => Promise<{ status: number }>>)[
        method
      ](url);
      expect(res.status).toBe(401);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* RBAC — refus par défaut                                                    */
/* -------------------------------------------------------------------------- */

describe("#142 RBAC — refus par défaut", () => {
  const readRoutes = [
    `${BASE}/capabilities`,
    `${BASE}/chain?type=lot&id=${LOT_ID}`,
    `${BASE}/expand?type=lot&id=${LOT_ID}&direction=upstream`,
    `${LEGACY}/chain?type=lot&id=${LOT_ID}`,
  ];

  for (const url of readRoutes) {
    it(`refuse ${url} à un rôle sans capacité de lecture`, async () => {
      mocks.currentRole.value = "role_sans_droit";
      const res = await request(app).get(url);
      expect(res.status).toBe(403);
      expect(res.body?.code ?? res.body?.error).toMatch(/TRACEABILITY_CAPABILITY_REQUIRED|Forbidden/i);
    });
  }

  it("refuse la recherche à un rôle sans capacité de recherche", async () => {
    mocks.currentRole.value = "role_sans_droit";
    const res = await request(app).get(`${BASE}/search?q=LOT-2026`);
    expect(res.status).toBe(403);
  });

  it("refuse l'analyse d'impact à l'atelier (lecture ≠ décision qualité)", async () => {
    mocks.currentRole.value = "Operateur atelier";
    const chain = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}`);
    expect(chain.status).toBe(200);

    const impact = await request(app).get(`${BASE}/impact?type=lot&id=${LOT_ID}`);
    expect(impact.status).toBe(403);
  });

  it("autorise l'analyse d'impact à la qualité", async () => {
    mocks.currentRole.value = "Responsable Qualite";
    const res = await request(app).get(`${BASE}/impact?type=lot&id=${LOT_ID}`);
    expect(res.status).toBe(200);
  });

  it("refuse la génération as-built à l'ADV mais autorise le téléchargement", async () => {
    mocks.currentRole.value = "ADV";
    const generate = await request(app)
      .post(`/api/v1/asbuilt/lots/${LOT_ID}/generate`)
      .send({ signataire_user_id: 1 });
    expect(generate.status).toBe(403);

    const download = await request(app).get(
      `/api/v1/asbuilt/lots/${LOT_ID}/download/22222222-2222-4222-8222-222222222222`
    );
    // 404 (document non rattaché) et non 403 : le droit est accordé, l'objet
    // n'existe pas. C'est exactement la distinction attendue.
    expect(download.status).toBe(404);
  });

  it("expose les capacités réelles de l'appelant, jamais un booléen inventé", async () => {
    mocks.currentRole.value = "Operateur atelier";
    const res = await request(app).get(`${BASE}/capabilities`);
    expect(res.status).toBe(200);
    expect(res.body.capabilities.read).toBe(true);
    expect(res.body.capabilities.impact).toBe(false);
    expect(res.body.capabilities.export).toBe(false);
    expect(res.body.capabilities.customer_data_read).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Anti-IDOR                                                                  */
/* -------------------------------------------------------------------------- */

describe("#142 anti-IDOR", () => {
  it("refuse un point de départ dont le TYPE est interdit (403, pas 404 déguisé)", async () => {
    mocks.currentRole.value = "Operateur atelier";
    const res = await request(app).get(`${BASE}/chain?type=client&id=ACM`);
    expect(res.status).toBe(403);
    expect(res.body?.code ?? res.body?.error).toMatch(/TRACEABILITY_NODE_FORBIDDEN|Forbidden/i);
  });

  it("refuse un fournisseur comme point de départ à l'atelier", async () => {
    mocks.currentRole.value = "Operateur atelier";
    const res = await request(app).get(
      `${BASE}/chain?type=fournisseur&id=33333333-3333-4333-8333-333333333333`
    );
    expect(res.status).toBe(403);
  });

  it("renvoie 404 quand le point de départ n'existe pas", async () => {
    mocks.poolQuery.mockImplementation(async () => ({ rows: [] }));
    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}`);
    expect(res.status).toBe(404);
    expect(res.body?.code ?? res.body?.error).toMatch(/TRACEABILITY_SEED_NOT_FOUND|Not Found/i);
  });

  it("ne laisse pas la recherche révéler un type interdit", async () => {
    mocks.currentRole.value = "Operateur atelier";
    const res = await request(app).get(`${BASE}/search?q=ACME&types=client`);
    expect(res.status).toBe(200);
    expect(res.body.hits).toHaveLength(0);
    expect(res.body.searched_types).not.toContain("client");
  });

  it("limite les types réellement interrogés à ceux que l'appelant peut voir", async () => {
    mocks.currentRole.value = "Operateur atelier";
    const res = await request(app).get(`${BASE}/search?q=LOT`);
    expect(res.status).toBe(200);
    expect(res.body.searched_types).toContain("lot");
    expect(res.body.searched_types).not.toContain("fournisseur");
    expect(res.body.searched_types).not.toContain("devis");
  });
});

/* -------------------------------------------------------------------------- */
/* Validation stricte                                                         */
/* -------------------------------------------------------------------------- */

describe("#142 validation", () => {
  it("rejette un type de nœud inconnu", async () => {
    const res = await request(app).get(`${BASE}/chain?type=facture_fantome&id=1`);
    expect(res.status).toBe(400);
  });

  it("rejette un paramètre inconnu (schéma strict)", async () => {
    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}&hack=1`);
    expect(res.status).toBe(400);
  });

  it("rejette une profondeur au-delà du plafond serveur", async () => {
    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}&maxDepth=99`);
    expect(res.status).toBe(400);
  });

  it("rejette un nombre de nœuds au-delà du plafond serveur", async () => {
    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}&maxNodes=100000`);
    expect(res.status).toBe(400);
  });

  it("rejette une période inversée", async () => {
    const res = await request(app).get(
      `${BASE}/chain?type=lot&id=${LOT_ID}&period_from=2026-12-01&period_to=2026-01-01`
    );
    expect(res.status).toBe(400);
  });

  it("rejette une date de référence invalide", async () => {
    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}&as_of=pas-une-date`);
    expect(res.status).toBe(400);
  });

  it("rejette un identifiant dont la forme ne correspond pas au type", async () => {
    // Un bigint là où PostgreSQL attend un uuid : refusé AVANT la requête,
    // sinon c'est une 500 au lieu d'un message utile.
    const res = await request(app).get(`${BASE}/chain?type=lot&id=42`);
    expect(res.status).toBe(422);
    expect(res.body?.code ?? res.body?.error).toMatch(/TRACEABILITY_SEED_INVALID|Unprocessable/i);
  });

  it("rejette une recherche trop courte (fuite de volume)", async () => {
    const res = await request(app).get(`${BASE}/search?q=L`);
    expect(res.status).toBe(400);
  });

  it("rejette une direction inconnue sur l'expansion", async () => {
    const res = await request(app).get(`${BASE}/expand?type=lot&id=${LOT_ID}&direction=sideways`);
    expect(res.status).toBe(400);
  });

  it("exige une direction explicite sur l'expansion", async () => {
    const res = await request(app).get(`${BASE}/expand?type=lot&id=${LOT_ID}`);
    expect(res.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* Contrat de réponse                                                         */
/* -------------------------------------------------------------------------- */

describe("#142 contrat de réponse", () => {
  it("renvoie seed, portée, couverture, preuves et sources", async () => {
    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.seed.code).toBe("LOT-2026-0001");
    expect(res.body.seed.type).toBe("lot");
    expect(res.body.as_of).toBeTruthy();
    expect(res.body.scope.direction).toBe("both");
    expect(res.body.coverage.state).toBeTruthy();
    expect(res.body.coverage.state_label).toBeTruthy();
    expect(Array.isArray(res.body.sources)).toBe(true);
    expect(res.body.sources).toContain("of_material_consumptions");
    expect(res.body.truncated).toHaveProperty("branches");
    expect(res.body).toHaveProperty("next_cursor");
  });

  it("expose un CODE MÉTIER, pas seulement un UUID", async () => {
    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}`);
    expect(res.body.seed.code).not.toBe(res.body.seed.id);
    expect(res.body.seed.code).toMatch(/^LOT-/);
  });

  it("expose la route vers la fiche autoritaire", async () => {
    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}`);
    expect(res.body.seed.route).toBe(`/stock/lots/${LOT_ID}`);
  });

  it("ne fuit AUCUN chemin de stockage ni secret", async () => {
    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}`);
    const payload = JSON.stringify(res.body);
    expect(payload).not.toMatch(/storage_path/i);
    expect(payload).not.toMatch(/stored_name/i);
    expect(payload).not.toMatch(/file_path/i);
    expect(payload).not.toMatch(/\/srv\/cerp/);
    expect(payload).not.toMatch(/password|secret|token/i);
  });

  it("respecte la direction demandée dans la portée", async () => {
    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}&direction=upstream`);
    expect(res.body.scope.direction).toBe("upstream");
  });

  it("borne silencieusement l'expansion à un seul niveau", async () => {
    const res = await request(app).get(
      `${BASE}/expand?type=lot&id=${LOT_ID}&direction=downstream`
    );
    expect(res.status).toBe(200);
    expect(res.body.scope.max_depth).toBe(1);
  });

  it("déclare explicitement que l'analyse d'impact est en lecture seule", async () => {
    mocks.currentRole.value = "Responsable Qualite";
    const res = await request(app).get(`${BASE}/impact?type=lot&id=${LOT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.read_only).toBe(true);
    expect(res.body.counts).toHaveProperty("CONFIRMED");
    expect(res.body.counts).toHaveProperty("NO_PROVEN_IMPACT");
  });

  it("classe « sans impact prouvé » plutôt que de conclure à l'absence d'impact", async () => {
    mocks.currentRole.value = "Responsable Qualite";
    const res = await request(app).get(`${BASE}/impact?type=lot&id=${LOT_ID}`);
    expect(res.body.items[0].classification).toBe("NO_PROVEN_IMPACT");
    expect(res.body.items[0].reason).toMatch(/n'est pas une garantie/i);
  });

  it("n'exécute AUCUNE écriture pendant une lecture de chaîne", async () => {
    await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}`);
    const statements = mocks.poolQuery.mock.calls.map((c) => String(c[0]));
    for (const sql of statements) {
      expect(sql).not.toMatch(/\bINSERT\s+INTO\s+public\.(lots|stock_movements|ordres_fabrication)/i);
      expect(sql).not.toMatch(/\bUPDATE\s+public\.(lots|stock_movements|ordres_fabrication)/i);
      expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Compatibilité du contrat historique                                        */
/* -------------------------------------------------------------------------- */

describe("#142 contrat historique /traceability/chain", () => {
  it("conserve exactement la forme attendue par les écrans déployés", async () => {
    const res = await request(app).get(`${LEGACY}/chain?type=lot&id=${LOT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.seed).toEqual({ type: "lot", id: LOT_ID });
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.edges)).toBe(true);
    expect(Array.isArray(res.body.highlights)).toBe(true);
    expect(res.body.truncated).toEqual({
      maxDepthReached: false,
      maxNodesReached: false,
      maxEdgesReached: false,
    });
    const node = res.body.nodes[0];
    expect(node).toHaveProperty("node_id");
    expect(node).toHaveProperty("type");
    expect(node).toHaveProperty("id");
    expect(node).toHaveProperty("label");
    expect(node).toHaveProperty("meta");
  });

  it("refuse toujours un type hors du contrat historique", async () => {
    const res = await request(app).get(`${LEGACY}/chain?type=metrology_equipment&id=${LOT_ID}`);
    expect(res.status).toBe(400);
  });

  it("est désormais protégé par RBAC, ce qui n'était pas le cas", async () => {
    mocks.currentRole.value = "role_sans_droit";
    const res = await request(app).get(`${LEGACY}/chain?type=lot&id=${LOT_ID}`);
    expect(res.status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
/* Performance : absence de N+1                                               */
/* -------------------------------------------------------------------------- */

describe("#142 performance", () => {
  it("ne multiplie pas les requêtes par nœud (pas de N+1)", async () => {
    // 40 OF renvoyés par le premier niveau : un moteur N+1 émettrait
    // ~40 requêtes de plus au niveau suivant. Ici, le nombre de requêtes est
    // borné par (types présents × familles de relation × profondeur).
    const ofIds = Array.from({ length: 40 }, (_, i) => String(100 + i));
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM public.of_output_lots ool") && text.includes("ool.lot_id = ANY")) {
        return {
          rows: ofIds.map((id, i) => ({
            from_id: id,
            to_id: LOT_ID,
            qty: 1,
            unit: null,
            effective_at: "2026-07-01T00:00:00.000Z",
            evidence_ref: `ool-${i}`,
            historical_status: null,
          })),
        };
      }
      return routeQuery(sql);
    });

    await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}&direction=upstream&maxDepth=3`);
    const total = mocks.poolQuery.mock.calls.length;
    expect(total).toBeLessThan(60);
  });

  it("plafonne le nombre de nœuds même si la base en renvoie beaucoup", async () => {
    const ofIds = Array.from({ length: 200 }, (_, i) => String(1000 + i));
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM public.of_output_lots ool") && text.includes("ool.lot_id = ANY")) {
        return {
          rows: ofIds.map((id, i) => ({
            from_id: id,
            to_id: LOT_ID,
            qty: 1,
            unit: null,
            effective_at: null,
            evidence_ref: `big-${i}`,
            historical_status: null,
          })),
        };
      }
      return routeQuery(sql);
    });

    const res = await request(app).get(
      `${BASE}/chain?type=lot&id=${LOT_ID}&direction=upstream&maxNodes=20`
    );
    expect(res.status).toBe(200);
    expect(res.body.nodes.length).toBeLessThanOrEqual(20);
    expect(res.body.coverage.complete).toBe(false);
  });

  it("survit à une table absente sans casser toute la chaîne", async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("of_material_consumptions")) {
        const err = new Error('relation "public.of_material_consumptions" does not exist') as Error & {
          code: string;
        };
        err.code = "42P01";
        throw err;
      }
      return routeQuery(sql);
    });

    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.seed.code).toBe("LOT-2026-0001");
  });

  it("survit à un refus de droit PostgreSQL sur une table (42501)", async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("stock_lot_genealogy_edges")) {
        const err = new Error("permission denied") as Error & { code: string };
        err.code = "42501";
        throw err;
      }
      return routeQuery(sql);
    });

    const res = await request(app).get(`${BASE}/chain?type=lot&id=${LOT_ID}`);
    expect(res.status).toBe(200);
  });
});
