import { describe, expect, it } from "vitest";

import {
  generateArticleBusinessCode,
  generateAffaireCode,
  generateBlCode,
  activateCutoverBusinessNumberSequenceTx,
  generateFabricatedArticleBusinessCode,
  generateMachineCode,
  generateTransactionalBusinessCode,
  previewPieceTechniqueCode,
} from "../shared/codes/code-generator.service";
import { isValidCode } from "../shared/codes/code-validator";

function sequenceTx(next: number) {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  return {
    calls,
    tx: {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [{ v: String(next) }] };
      },
    },
  };
}

describe("Codification métier centralisée", () => {
  it("normalise un code de pièce à partir du client, plan et indice externe", () => {
    expect(previewPieceTechniqueCode({
      clientCode: "1",
      planReference: "1702595 0000",
      indiceExterne: "c-1",
    })).toBe("001-1702595-0000-C1");
  });

  it("conserve les groupes de la référence plan dans le code PT", () => {
    expect(previewPieceTechniqueCode({
      clientCode: "CLI-001",
      planReference: "170 25464 001",
      indiceExterne: "A",
    })).toBe("001-170-25464-001-A");
  });

  it("réserve la séquence article dans PostgreSQL et ne reçoit pas le code final du client", async () => {
    const { tx, calls } = sequenceTx(42);
    await expect(generateArticleBusinessCode(tx as never, "usinage")).resolves.toBe("ART-USINAGE-000042");
    expect(calls[0]?.sql).toContain("fn_next_issued_code_value");
    expect(calls[0]?.values).toEqual(["ART:USINAGE"]);
  });

  it("generates a fabricated article code from the applicable technical-piece identity", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const tx = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return {
          rows: [{
            piece_exists: true,
            client_code: "CLI-001",
            plan_reference: "1702595 0000",
            indice: "a-1",
            version_interne: 1,
          }],
        };
      },
    };

    await expect(generateFabricatedArticleBusinessCode(tx as never, "11111111-1111-4111-8111-111111111111"))
      .resolves.toBe("ART-FAB-001-1702595-0000-A1");
    expect(calls[0]?.sql).toContain("pv.statut = 'APPLICABLE'");
    expect(calls[0]?.values).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("adds only an internal version above one to a fabricated article code", async () => {
    const tx = {
      query: async () => ({
        rows: [{
          piece_exists: true,
          client_code: "002",
          plan_reference: "PLAN-42",
          indice: "B",
          version_interne: 3,
        }],
      }),
    };

    await expect(generateFabricatedArticleBusinessCode(tx as never, "22222222-2222-4222-8222-222222222222"))
      .resolves.toBe("ART-FAB-002-PLAN-42-B-V3");
  });

  it("rejects a fabricated article when its technical piece has no client code", async () => {
    const tx = {
      query: async () => ({
        rows: [{
          piece_exists: true,
          client_code: null,
          plan_reference: "PLAN-42",
          indice: "B",
          version_interne: 1,
        }],
      }),
    };

    await expect(generateFabricatedArticleBusinessCode(tx as never, "33333333-3333-4333-8333-333333333333"))
      .rejects.toMatchObject({ code: "CLIENT_CODE_REQUIRED" });
  });

  it.each([
    {
      label: "technical piece",
      row: undefined,
      code: "INVALID_PIECE_TECHNIQUE",
    },
    {
      label: "plan reference",
      row: {
        piece_exists: true,
        client_code: "001",
        plan_reference: null,
        indice: "A",
        version_interne: 1,
      },
      code: "PLAN_REFERENCE_REQUIRED",
    },
    {
      label: "external index",
      row: {
        piece_exists: true,
        client_code: "001",
        plan_reference: "PLAN-42",
        indice: null,
        version_interne: 1,
      },
      code: "INDEX_REQUIRED",
    },
  ])("rejects a fabricated article when its $label is missing", async ({ row, code }) => {
    const tx = {
      query: async () => ({ rows: row ? [row] : [] }),
    };

    await expect(generateFabricatedArticleBusinessCode(
      tx as never,
      "44444444-4444-4444-8444-444444444444"
    )).rejects.toMatchObject({ code });
  });

  it("produit les formats transactionnels DEV, CMD, AFF et OF avec les largeurs attendues", async () => {
    const date = new Date("2026-07-13T00:00:00.000Z");
    await expect(generateTransactionalBusinessCode(sequenceTx(7).tx as never, { prefix: "DEV", date })).resolves.toBe("DEV-2026-0007");
    await expect(generateTransactionalBusinessCode(sequenceTx(7).tx as never, { prefix: "CMD", date })).resolves.toBe("CMD-2026-0007");
    await expect(generateTransactionalBusinessCode(sequenceTx(7).tx as never, { prefix: "AFF", date })).resolves.toBe("AFF-2026-0007");
    await expect(generateTransactionalBusinessCode(sequenceTx(7).tx as never, { prefix: "OF", date })).resolves.toBe("OF-2026-000007");
  });

  it("garde les numéros historiques tant que la bascule n'est pas activée", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const tx = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes("to_regclass")) return { rows: [{ relation: "public.cutover_business_number_sequences" }] };
        if (sql.includes("cutover_business_number_sequences")) return { rows: [] };
        return { rows: [{ v: "7" }] };
      },
    };

    await expect(generateAffaireCode(tx as never, { type: "LIV", client_code: "001", date: new Date("2026-07-13T00:00:00.000Z") }))
      .resolves.toBe("AFF-2026-0007");
    expect(calls[0]?.sql).toContain("to_regclass");
    expect(calls[1]?.sql).toContain("cutover_business_number_sequences");
    expect(calls[2]?.sql).toContain("fn_next_issued_code_value");
  });

  it("alloue les nouveaux compteurs affair/BL seulement après activation et conserve le compteur au changement d'année", async () => {
    const activeSequence = {
      query: async (sql: string) => {
        if (sql.includes("to_regclass")) return { rows: [{ relation: "public.cutover_business_number_sequences" }] };
        if (sql.includes("cutover_business_number_sequences")) return { rows: [{ allocated_value: "24000" }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    await expect(generateAffaireCode(activeSequence as never, { type: "LIV", client_code: "001", date: new Date("2027-01-01T00:30:00.000Z") }))
      .resolves.toBe("AFF-LIV-27-24000");

    const activeBl = {
      query: async (sql: string) => {
        if (sql.includes("to_regclass")) return { rows: [{ relation: "public.cutover_business_number_sequences" }] };
        if (sql.includes("cutover_business_number_sequences")) return { rows: [{ allocated_value: "15000" }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    await expect(generateBlCode(activeBl as never, { date: new Date("2027-01-01T00:30:00.000Z") }))
      .resolves.toBe("BL-27-15000");
  });

  it("refuse de réinitialiser un compteur de bascule déjà actif", async () => {
    const tx = {
      query: async (sql: string) => {
        if (sql.includes("SELECT next_value")) return { rows: [{ next_value: "24001", active: true }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    await expect(activateCutoverBusinessNumberSequenceTx(tx as never, {
      scope: "AFFAIRE_LIVRAISON", nextValue: 24000, actorId: 7,
    })).rejects.toMatchObject({ code: "CUTOVER_NUMBERING_ALREADY_ACTIVE" });
  });

  it("reserve le code machine MCH transactionnellement dans le registre central", async () => {
    const { tx, calls } = sequenceTx(42);
    await expect(generateMachineCode(tx as never)).resolves.toBe("MCH-000042");
    expect(calls[0]?.sql).toContain("fn_next_issued_code_value");
    expect(calls[0]?.values).toEqual(["MCH"]);
  });

  it("expose les formats canoniques tout en gardant les références historiques lisibles", () => {
    expect(isValidCode("pieceTechnique", "001-17025950000-C")).toBe(true);
    expect(isValidCode("pieceTechnique", "001-170-25464-001-C")).toBe(true);
    expect(isValidCode("article", "ART-USI-000042")).toBe(true);
    expect(isValidCode("article", "ART-FAB-001-17025950000-A")).toBe(true);
    expect(isValidCode("article", "ART-FAB-001-170-25464-001-A")).toBe(true);
    expect(isValidCode("article", "ART-FAB-001-17025950000-A-V2")).toBe(true);
    expect(isValidCode("article", "ART-FAB-001-170-25464-001-A-V2")).toBe(true);
    expect(isValidCode("article", "ART-FAB-001-17025950000-A-V10")).toBe(true);
    expect(isValidCode("article", "ART-FAB-001-17025950000-A-V1")).toBe(false);
    expect(isValidCode("commande", "CMD-2026-0007")).toBe(true);
    expect(isValidCode("of", "OF-2026-000007")).toBe(true);
    expect(isValidCode("commande", "CC-123")).toBe(true);
    expect(isValidCode("affaire", "AFF-LIV-26-24000")).toBe(true);
    expect(isValidCode("bonLivraison", "BL-26-15000")).toBe(true);
    expect(isValidCode("bonLivraison", "BL-00015000")).toBe(true);
  });
});
