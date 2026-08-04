import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../repository/pieces-techniques.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repository/pieces-techniques.repository")>()),
  repoCreatePieceTechnique: (...args: unknown[]) => mocks.create(...args),
}));

import type { CreatePieceTechniqueBodyDTO } from "../validators/pieces-techniques.validators";
import {
  createPieceTechniqueSVC,
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
    mocks.create.mockResolvedValue({ id: "piece-1", code_piece: "045-10233-000" });
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
});
