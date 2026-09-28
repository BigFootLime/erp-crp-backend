import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const upload = vi.hoisted(() => ({ invoked: vi.fn() }));

vi.mock("../shared/uploads/secure-upload", () => ({
  createSecureUpload: () => ({
    array: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      upload.invoked(req);
      next();
    },
  }),
}));

vi.mock("../module/access-control/context/account-module-access.context", () => ({
  requestHasGrantedAccountModuleAccess: () => true,
}));

vi.mock("../module/devis/controllers/devis.controller", () => {
  const unavailable = (_req: express.Request, res: express.Response) => res.sendStatus(501);
  return {
    createDevis: (_req: express.Request, res: express.Response) => res.status(201).json({ id: 1 }),
    convertDevisToCommande: unavailable,
    deleteDevis: unavailable,
    findDevisByArticle: unavailable,
    findDevisByArticleDevisCode: unavailable,
    getCommandeDraftFromDevis: unavailable,
    getDevis: unavailable,
    getDevisDocumentFile: unavailable,
    getDevisOfficialDocument: unavailable,
    listDevis: unavailable,
    listDevisOfficialDocuments: unavailable,
    queueDevisOfficialDocument: unavailable,
    previewDevisOfficialDocument: unavailable,
    downloadDevisOfficialDocument: unavailable,
    printDevisOfficialDocument: unavailable,
    listDevisVersions: unavailable,
    reviseDevis: unavailable,
    updateDevis: unavailable,
  };
});

import devisRoutes from "../module/devis/routes/devis.routes";

const originalDemo = process.env.CERP_DEMO_MODE;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = { id: 1, role: "Directeur" };
    next();
  });
  instance.use("/devis", devisRoutes);
  instance.use((error: { status?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ code: error.code ?? "INTERNAL" });
  });
  return instance;
}

const draft = {
  client_id: "DEMO01",
  statut: "BROUILLON",
  lignes: [{ description: "Pièce de démonstration", prix_unitaire_ht: 100 }],
};

describe("CERP-DEMO-01 quote draft creation", () => {
  afterEach(() => {
    if (originalDemo === undefined) delete process.env.CERP_DEMO_MODE;
    else process.env.CERP_DEMO_MODE = originalDemo;
    upload.invoked.mockClear();
  });

  it("accepts a JSON draft without invoking upload storage", async () => {
    process.env.CERP_DEMO_MODE = "true";
    await request(app()).post("/devis").send(draft).expect(201);
    expect(upload.invoked).not.toHaveBeenCalled();
  });

  it("rejects multipart and non-draft statuses before upload storage", async () => {
    process.env.CERP_DEMO_MODE = "true";
    await request(app()).post("/devis").field("data", JSON.stringify(draft)).expect(403);
    await request(app()).post("/devis").send({ ...draft, statut: "ENVOYE" }).expect(403);
    expect(upload.invoked).not.toHaveBeenCalled();
  });

  it("preserves the legacy create middleware chain outside demo mode", async () => {
    process.env.CERP_DEMO_MODE = "false";
    await request(app()).post("/devis").send({ data: JSON.stringify(draft) }).expect(201);
    expect(upload.invoked).toHaveBeenCalledOnce();
  });
});
