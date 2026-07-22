import { describe, expect, it } from "vitest";

import {
  generateArticleBusinessCode,
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
    })).toBe("001-17025950000-C1");
  });

  it("réserve la séquence article dans PostgreSQL et ne reçoit pas le code final du client", async () => {
    const { tx, calls } = sequenceTx(42);
    await expect(generateArticleBusinessCode(tx as never, "usinage")).resolves.toBe("ART-USINAGE-000042");
    expect(calls[0]?.sql).toContain("fn_next_issued_code_value");
    expect(calls[0]?.values).toEqual(["ART:USINAGE"]);
  });

  it("produit les formats transactionnels DEV, CMD, AFF et OF avec les largeurs attendues", async () => {
    const date = new Date("2026-07-13T00:00:00.000Z");
    await expect(generateTransactionalBusinessCode(sequenceTx(7).tx as never, { prefix: "DEV", date })).resolves.toBe("DEV-2026-0007");
    await expect(generateTransactionalBusinessCode(sequenceTx(7).tx as never, { prefix: "CMD", date })).resolves.toBe("CMD-2026-0007");
    await expect(generateTransactionalBusinessCode(sequenceTx(7).tx as never, { prefix: "AFF", date })).resolves.toBe("AFF-2026-0007");
    await expect(generateTransactionalBusinessCode(sequenceTx(7).tx as never, { prefix: "OF", date })).resolves.toBe("OF-2026-000007");
  });

  it("reserve le code machine MCH transactionnellement dans le registre central", async () => {
    const { tx, calls } = sequenceTx(42);
    await expect(generateMachineCode(tx as never)).resolves.toBe("MCH-000042");
    expect(calls[0]?.sql).toContain("fn_next_issued_code_value");
    expect(calls[0]?.values).toEqual(["MCH"]);
  });

  it("expose les formats canoniques tout en gardant les références historiques lisibles", () => {
    expect(isValidCode("pieceTechnique", "001-17025950000-C")).toBe(true);
    expect(isValidCode("article", "ART-USI-000042")).toBe(true);
    expect(isValidCode("commande", "CMD-2026-0007")).toBe(true);
    expect(isValidCode("of", "OF-2026-000007")).toBe(true);
    expect(isValidCode("commande", "CC-123")).toBe(true);
  });
});
