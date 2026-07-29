// Les routes #370 existent-elles RÉELLEMENT ?
//
// Ce fichier ne teste pas de la logique métier : il vérifie que la surface HTTP
// est montée dans l'application, qu'elle refuse par défaut, et que les gardes
// s'appliquent dans le bon ordre. Une route seulement référencée par le frontend
// répondrait 404 — c'est précisément ce que ces tests attrapent.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// Le module de base de données est remplacé : ces tests n'ouvrent aucune
// connexion. Ils vérifient le routage et l'autorisation, pas le SQL.
vi.mock("../config/database", () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn() },
}));

const ROLE_HEADER = "x-test-role";

// L'authentification est simulée : le rôle EFFECTIF est injecté par en-tête, tel
// que `authorizationRole()` le produirait à la connexion (chaîne « A | B »).
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const role = req.headers[ROLE_HEADER];
    if (typeof role !== "string") {
      res.status(401).json({ error: "Token manquant ou invalide" });
      return;
    }
    req.user = { id: 42, username: "testeur", email: "t@example.test", role };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

async function buildApp() {
  const routes = (await import("../module/production/routes/of-versioning.routes")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/v1/production/of-versioning", routes);
  // Traduction des HttpError en réponse, comme le fait le gestionnaire global.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.status ?? 500).json({ code: err?.code ?? "ERROR", message: err?.message });
  });
  return app;
}

const BASE = "/api/v1/production/of-versioning";

/** Rôles effectifs réels, tels qu'ils sortent des alias d'organigramme. */
const PLANIFICATION = "Planification";
const ATELIER = "Production | Atelier";
const OPERATEUR = "Opérateur atelier";
const COMMERCIAL = "Commercial";

describe("#370 — la surface HTTP est réellement montée", () => {
  it("expose /capabilities pour un compte authentifié", async () => {
    const app = await buildApp();
    const res = await request(app).get(`${BASE}/capabilities`).set(ROLE_HEADER, ATELIER);
    expect(res.status).toBe(200);
    expect(res.body.capabilities).toMatchObject({ read: true, visa: true });
  });

  it("refuse tout accès sans authentification (401, jamais 404)", async () => {
    const app = await buildApp();
    // Un 404 ici signifierait que la route n'existe pas ; un 401 prouve qu'elle
    // existe ET qu'elle est gardée.
    for (const path of [
      `${BASE}/1/revisions`,
      `${BASE}/1/planning-versions`,
      `${BASE}/1/document/preview`,
      `${BASE}/ar-dossiers`,
    ]) {
      const res = await request(app).get(path);
      expect(res.status, `GET ${path}`).toBe(401);
    }
  });

  it("monte les 20 routes du chantier", async () => {
    const routes = (await import("../module/production/routes/of-versioning.routes")).default;
    const mounted = (routes as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack
      .filter((layer) => layer.route)
      .map((layer) => {
        const method = Object.keys(layer.route!.methods)[0].toUpperCase();
        return `${method} ${layer.route!.path}`;
      });

    expect(mounted).toEqual(
      expect.arrayContaining([
        "GET /capabilities",
        "GET /machine-families",
        "GET /ar-dossiers",
        "PATCH /ar-dossiers/:dossierId",
        "GET /:ofId/revisions",
        "GET /:ofId/revisions/compare",
        "GET /:ofId/revisions/:revisionId",
        "POST /:ofId/revisions",
        "POST /:ofId/revisions/:revisionId/visas",
        "POST /:ofId/time-variance/assess",
        "GET /:ofId/time-variance",
        "POST /:ofId/time-variance",
        "POST /:ofId/time-variance/:proposalId/resolve",
        "GET /:ofId/planning-versions",
        "POST /:ofId/planning-versions",
        "POST /:ofId/planning-versions/:versionId/submit",
        "POST /:ofId/planning-versions/:versionId/validate",
        "POST /:ofId/planning-versions/:versionId/refuse",
        "POST /:ofId/ar-dossiers",
        "GET /:ofId/document/preview",
        "GET /:ofId/document/preview.pdf",
        "GET /:ofId/documents",
        "POST /:ofId/documents",
        "GET /:ofId/documents/:documentId/pdf",
      ])
    );
  });

  it("déclare /ar-dossiers avant /:ofId pour ne pas le capturer comme un identifiant", async () => {
    const app = await buildApp();
    // Si l'ordre était inversé, « ar-dossiers » serait parsé comme `ofId` et la
    // validation renverrait 400. Un 200 prouve que la route littérale gagne.
    const res = await request(app).get(`${BASE}/ar-dossiers`).set(ROLE_HEADER, COMMERCIAL);
    expect(res.status).not.toBe(400);
  });
});

describe("#370 — refus par défaut et capacités fines", () => {
  it("refuse à un opérateur atelier la validation d'un planning (403)", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post(`${BASE}/1/planning-versions/6b1f6f7e-0000-4000-8000-000000000000/validate`)
      .set(ROLE_HEADER, OPERATEUR)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OF_CAPABILITY_REQUIRED");
  });

  it("refuse à l'atelier la création d'une révision (403)", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post(`${BASE}/1/revisions`)
      .set(ROLE_HEADER, OPERATEUR)
      .set("Idempotency-Key", "abcdefgh-0001")
      .send({ motif: "essai" });
    expect(res.status).toBe(403);
  });

  it("refuse à la planification le recalage d'un AR (403) — acte commercial", async () => {
    const app = await buildApp();
    const res = await request(app).get(`${BASE}/ar-dossiers`).set(ROLE_HEADER, PLANIFICATION);
    expect(res.status).toBe(403);
  });

  it("autorise la planification à valider un planning", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post(`${BASE}/1/planning-versions/6b1f6f7e-0000-4000-8000-000000000000/validate`)
      .set(ROLE_HEADER, PLANIFICATION)
      .send({});
    // La garde passe ; l'échec vient ensuite de la base simulée, pas du RBAC.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});

describe("#370 — la clé d'idempotence est exigée sur les commandes à effet", () => {
  const COMMANDS: Array<[string, string, string]> = [
    ["post", `${BASE}/1/revisions`, PLANIFICATION],
    ["post", `${BASE}/1/revisions/6b1f6f7e-0000-4000-8000-000000000000/visas`, ATELIER],
    ["post", `${BASE}/1/time-variance`, PLANIFICATION],
    ["post", `${BASE}/1/planning-versions`, PLANIFICATION],
    ["post", `${BASE}/1/ar-dossiers`, COMMERCIAL],
    ["post", `${BASE}/1/documents`, PLANIFICATION],
  ];

  it.each(COMMANDS)("%s %s exige Idempotency-Key", async (_method, path, role) => {
    const app = await buildApp();
    const res = await request(app).post(path).set(ROLE_HEADER, role).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("n'exige AUCUNE clé sur les lectures et les aperçus", async () => {
    const app = await buildApp();
    // L'évaluation de dérive écrit rien : exiger une clé serait une fausse
    // contrainte, et l'UI ne pourrait pas afficher le verdict du seuil en direct.
    const res = await request(app)
      .post(`${BASE}/1/time-variance/assess`)
      .set(ROLE_HEADER, PLANIFICATION)
      .send({ phase: 10, newTime: 1 });
    expect(res.status).not.toBe(400);
  });
});

describe("#370 — la surface est bien greffée sur le routeur v1", () => {
  it("est montée sous /production/of-versioning dans v1.routes", async () => {
    // Lecture du fichier de montage : c'est le seul point où une surface peut
    // exister en tant que routeur sans être atteignable par l'API.
    const fs = await import("node:fs/promises");
    const source = await fs.readFile("src/routes/v1.routes.ts", "utf8");
    expect(source).toContain('from "../module/production/routes/of-versioning.routes"');
    expect(source).toContain('router.use("/production/of-versioning", ofVersioningRoutes)');

    // …et AVANT le routeur historique, sinon `/production/:id` l'absorberait.
    const specific = source.indexOf('router.use("/production/of-versioning"');
    const legacy = source.indexOf('router.use("/production", productionRoutes)');
    expect(specific).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(specific);
  });
});
