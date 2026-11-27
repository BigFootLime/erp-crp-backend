import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../../middlewares/errorHandler";
import { readConsumables } from "./consumable-procurement.controller";
import { getOfTechnicalSnapshot } from "./production.controller";
import { generateSelfInspection, preparationWorkbench } from "./production-workbench.controller";

const fixture = vi.hoisted(() => {
  const minimum = {
    id: "achat-minimum", type_achat: "TRAITEMENT", designation: "Finition",
    quantite: 4, prix: 1.5, pu_achat: 1.5, forfait_ht: null, minimum_facturation_ht: 15.25,
    tarif: 2, prix_par_quantite: 6, tva_achat: 20, total_achat_ht: 15.25, total_achat_ttc: 18.3,
  };
  const forfait = {
    ...minimum, id: "achat-forfait", prix: null, pu_achat: null,
    forfait_ht: 12.25, minimum_facturation_ht: null, total_achat_ht: 12.25, total_achat_ttc: 14.7,
  };
  const achats = [minimum, forfait];
  const snapshot = { achats, preparation_evidence: { purchases: achats } };
  const evaluation = {
    of: { id: 10, technical_snapshot_sha256: "stored-snapshot-hash", technical_snapshot: snapshot },
    sources: { purchases: achats },
    source_hash: "stored-source-hash",
    sheet_hash: "stored-sheet-hash",
  };
  return { achats, snapshot, evaluation };
});

vi.mock("../../access-control/services/access-control.service", () => ({
  resolveAccessProfile: vi.fn(async (id: number) => ({
    is_superadmin: false,
    modules: [
      { module_key: "production", allowed: true },
      { module_key: "commandes-fournisseurs", allowed: id === 2 },
    ],
  })),
}));

vi.mock("../repository/consumable-procurement-read.repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("../repository/consumable-procurement-read.repository")>(),
  getOfConsumables: vi.fn(async () => ({ needs: [], otherPurchases: fixture.achats })),
}));

vi.mock("../services/production.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/production.service")>(),
  svcGetOfTechnicalSnapshot: vi.fn(async () => ({
    of_id: 10, snapshot: fixture.snapshot, snapshot_sha256: "stored-snapshot-hash",
  })),
}));

vi.mock("../services/production-workbench.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/production-workbench.service")>(),
  svcPreparationWorkbench: vi.fn(async () => fixture.evaluation),
  svcGenerateSelfInspection: vi.fn(async () => fixture.evaluation),
}));

const base = "/api/v1/production/ofs/10";
const app = express()
  .use(express.json())
  .use((req, _res, next) => {
    req.user = { id: Number(req.header("x-test-account")), role: "Directeur" } as typeof req.user;
    next();
  })
  .get("/api/v1/production/ofs/:id/consumables", readConsumables)
  .get("/api/v1/production/ofs/:id/technical-snapshot", getOfTechnicalSnapshot)
  .get("/api/v1/production/ofs/:id/workbench", preparationWorkbench)
  .post("/api/v1/production/ofs/:id/workbench/self-inspection", generateSelfInspection)
  .use(errorHandler);

const deniedLines = fixture.achats.map(achat => ({
  ...achat, prix: null, pu_achat: null, forfait_ht: null, minimum_facturation_ht: null,
  tarif: null, prix_par_quantite: null, tva_achat: null, total_achat_ht: null, total_achat_ttc: null,
}));

describe("purchase price visibility in OF responses", () => {
  it.each([false, true])("applies supplier price permission %s to the raw consumables response", async (prices) => {
    const result = await request(app).get(`${base}/consumables`).set("x-test-account", prices ? "2" : "1");
    expect(result.status).toBe(200);
    expect(result.body.permissions.prices).toBe(prices);
    expect(result.body.otherPurchases).toEqual(prices ? fixture.achats : deniedLines);
  });

  it.each([false, true])("applies supplier price permission %s to snapshots without changing the stored hash", async (prices) => {
    const result = await request(app).get(`${base}/technical-snapshot`).set("x-test-account", prices ? "2" : "1");
    expect(result.status).toBe(200);
    const purchases = prices ? fixture.achats : deniedLines;
    expect(result.body).toMatchObject({
      snapshot_sha256: "stored-snapshot-hash",
      snapshot: { achats: purchases, preparation_evidence: { purchases } },
    });
    expect(fixture.snapshot.preparation_evidence.purchases[1].forfait_ht).toBe(12.25);
  });

  it.each([false, true])("applies supplier price permission %s to consultation and mutation workbench responses", async (prices) => {
    const account = prices ? "2" : "1";
    const results = await Promise.all([
      request(app).get(`${base}/workbench`).set("x-test-account", account),
      request(app).post(`${base}/workbench/self-inspection`).set("x-test-account", account)
        .send({ expected_updated_at: "2026-11-26T12:00:00Z" }),
    ]);
    const purchases = prices ? fixture.achats : deniedLines;
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        sources: { purchases },
        of: {
          technical_snapshot_sha256: "stored-snapshot-hash",
          technical_snapshot: { achats: purchases, preparation_evidence: { purchases } },
        },
        source_hash: "stored-source-hash",
        sheet_hash: "stored-sheet-hash",
      });
    }
  });
});
