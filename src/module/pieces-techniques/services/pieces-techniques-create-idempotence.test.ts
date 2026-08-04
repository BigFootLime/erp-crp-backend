import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../repository/pieces-techniques.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repository/pieces-techniques.repository")>()),
  repoCreatePieceTechnique: (...args: unknown[]) => mocks.create(...args),
}));

import type { CreatePieceTechniqueBodyDTO } from "../validators/pieces-techniques.validators";
import {
  createPieceTechniqueSVC,
  createPieceTechniqueWithReplaySVC,
  pieceTechniqueCreateCompatibleRequestHashes,
  pieceTechniqueCreateRequestHash,
} from "./pieces-techniques.service";

const body = {
  client_id: "045",
  name_piece: "Carter",
  designation: "Carter aluminium",
  plan_reference: "10233",
  indice_externe: "000",
  sans_indice: false,
  prix_unitaire: 0,
  statut: "DRAFT",
  ensemble: false,
  bom: [],
  operations: [],
  achats: [],
} satisfies CreatePieceTechniqueBodyDTO;

const audit = {
  user_id: 42,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: "/api/v1/pieces-techniques",
  page_key: "pieces-techniques",
  client_session_id: null,
};

describe("#309 — service de création idempotente", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockResolvedValue({
      piece: { id: "piece-1", code_piece: "045-10233-000" },
      replayed: false,
    });
  });

  it("transmet la clé et le hash du DTO validé au repository transactionnel", async () => {
    await createPieceTechniqueSVC(body, audit, "wizard-309-key-01");

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ designation: "Carter aluminium", operations: [], achats: [] }),
      audit,
      "wizard-309-key-01",
      pieceTechniqueCreateRequestHash(body),
      pieceTechniqueCreateCompatibleRequestHashes(body)
    );
  });

  it("produit un autre hash lorsque le payload métier change", () => {
    expect(pieceTechniqueCreateRequestHash({ ...body, designation: "Carter révisé" })).not.toBe(
      pieceTechniqueCreateRequestHash(body)
    );
  });

  it("accepte les empreintes historiques DTO validé et DTO enrichi", () => {
    const hashes = pieceTechniqueCreateCompatibleRequestHashes(body);

    expect(hashes).toContain(pieceTechniqueCreateRequestHash(body));
    expect(new Set(hashes).size).toBe(2);
  });

  it("préserve le flag de rejeu pour le contrôleur HTTP sans casser l'appel historique", async () => {
    mocks.create.mockResolvedValueOnce({
      piece: { id: "piece-1", code_piece: "045-10233-000", bom: [], operations: [], achats: [] },
      replayed: true,
    });

    const httpResult = await createPieceTechniqueWithReplaySVC(body, audit, "wizard-309-key-01");
    expect(httpResult).toMatchObject({ replayed: true, piece: { id: "piece-1" } });

    mocks.create.mockResolvedValueOnce({
      piece: { id: "piece-1", code_piece: "045-10233-000" },
      replayed: false,
    });
    await expect(createPieceTechniqueSVC(body, audit, "wizard-309-key-02")).resolves.toMatchObject({
      id: "piece-1",
    });
  });

  it("ne transforme jamais la contrainte d'idempotence en CODE_ALREADY_EXISTS", async () => {
    const idempotencyViolation = Object.assign(new Error("duplicate idempotency key"), {
      code: "23505",
      constraint: "piece_technique_create_idempotence_pkey",
    });
    mocks.create.mockRejectedValueOnce(idempotencyViolation);

    await expect(
      createPieceTechniqueWithReplaySVC(body, audit, "wizard-309-key-01")
    ).rejects.toBe(idempotencyViolation);
  });

  it("continue à traduire une autre contrainte unique métier", async () => {
    mocks.create.mockRejectedValueOnce(
      Object.assign(new Error("duplicate code"), {
        code: "23505",
        constraint: "pieces_techniques_code_piece_key",
        detail: "Key (code_piece)=(045-10233-000) already exists",
      })
    );

    await expect(createPieceTechniqueWithReplaySVC(body, audit, "wizard-309-key-01")).rejects.toMatchObject({
      status: 409,
      code: "CODE_ALREADY_EXISTS",
    });
  });
});
