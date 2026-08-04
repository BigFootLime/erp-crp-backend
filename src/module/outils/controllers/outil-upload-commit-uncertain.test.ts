import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteFile: vi.fn(),
  createFamille: vi.fn(),
  updateFamille: vi.fn(),
  createFabricant: vi.fn(),
  updateFabricant: vi.fn(),
  createGeometrie: vi.fn(),
  updateGeometrie: vi.fn(),
}));

vi.mock("../../../utils/imageStorage", () => ({ deleteStoredImageFile: mocks.deleteFile }));
vi.mock("../services/outil.service", () => ({
  outilService: {},
  outilSupportService: {
    createFamille: mocks.createFamille,
    updateFamille: mocks.updateFamille,
    createFabricant: mocks.createFabricant,
    updateFabricant: mocks.updateFabricant,
    createGeometrie: mocks.createGeometrie,
    updateGeometrie: mocks.updateGeometrie,
  },
}));
vi.mock("../utils/outillage-upload", () => ({
  getOutillageFabricantStoredPath: (name: string) => `fabricants/${name}`,
  getOutillageFamilleStoredPath: (name: string) => `familles/${name}`,
  getOutillageGeometrieStoredPath: (name: string) => `geometries/${name}`,
  getOutillageToolStoredPath: (name: string) => `outils/${name}`,
}));
vi.mock("../validators/outil.validator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../validators/outil.validator")>();
  return {
    ...actual,
    createFamilleSchema: { parse: () => ({ nom_famille: "FAMILLE" }) },
    updateFamilleSchema: { parse: () => ({ nom_famille: "FAMILLE" }) },
    createFabricantSchema: { parse: () => ({ nom_fabricant: "FABRICANT", id_fournisseurs: [] }) },
    updateFabricantSchema: { parse: () => ({ nom_fabricant: "FABRICANT", id_fournisseurs: [] }) },
    createGeometrieSchema: { parse: () => ({ nom_geometrie: "GEOMETRIE", id_famille: 1 }) },
    updateGeometrieSchema: { parse: () => ({ nom_geometrie: "GEOMETRIE", id_famille: 1 }) },
  };
});

import { RealtimeCommitUncertainError } from "../../../shared/realtime/realtime-outbox-transaction";
import { outilSupportController } from "./outil.controller";

function response(): Response {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}

describe("Outillage support upload cleanup after an uncertain commit", () => {
  beforeEach(() => vi.clearAllMocks());

  const cases = [
    ["postFamille", mocks.createFamille, { body: {}, params: {} }],
    ["patchFamille", mocks.updateFamille, { body: {}, params: { id: "1" } }],
    ["postFabricant", mocks.createFabricant, { body: { id_fournisseurs: "[]" }, params: {} }],
    ["patchFabricant", mocks.updateFabricant, { body: { id_fournisseurs: "[]" }, params: { id: "1" } }],
    ["postGeometrie", mocks.createGeometrie, { body: {}, params: {} }],
    ["patchGeometrie", mocks.updateGeometrie, { body: {}, params: { id: "1" } }],
  ] as const;

  for (const [method, service, request] of cases) {
    it(`${method} conserve le fichier pour rapprochement`, async () => {
      const error = new RealtimeCommitUncertainError();
      service.mockRejectedValueOnce(error);
      const next = vi.fn();
      await outilSupportController[method](
        {
          ...request,
          user: { id: 1, username: "test", email: "test@example.invalid", role: "admin" },
          file: { filename: "upload.png" },
        } as unknown as Request,
        response(),
        next
      );
      expect(mocks.deleteFile).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(error);
    });
  }
});
