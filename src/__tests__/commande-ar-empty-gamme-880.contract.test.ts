import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("#880 — archive AR exacte", () => {
  it("file dans la GED les octets exacts du PDF préparé", () => {
    const source = read("src/module/commande-client/repository/commande-ar.repository.ts");
    const archiveCall = source.slice(
      source.indexOf("await queueCreationPdfArchive(tx"),
      source.indexOf("actorUserId: params.user_id", source.indexOf("await queueCreationPdfArchive(tx")) + 100
    );

    expect(archiveCall).toContain("exactPdfBytes: pdfBuffer");
  });
});

describe("#880 — gamme vide non bloquante", () => {
  it("conserve l'OF et expose un avertissement au lieu d'annuler la transaction", () => {
    const source = read("src/module/production/domain/of-generation.ts");
    const copy = source.slice(
      source.indexOf("const operationsCount = await copyPieceOperationsToOf"),
      source.indexOf("await tx.query(\n      `\n        INSERT INTO public.of_technical_snapshots")
    );

    expect(copy).toContain("GAMME_WITHOUT_OPERATION:");
    expect(copy).not.toContain("PIECE_TECHNIQUE_OPERATION_REQUIRED");
    expect(source).toContain("operations_count: operationsCount");
  });

  it("classe également la gamme vide en avertissement dans l'aperçu", () => {
    const source = read("src/module/production/repository/production-generation.repository.ts");
    const emptyGamme = source.slice(
      source.indexOf("if (technical && operationsCount === 0)"),
      source.indexOf("const documents", source.indexOf("if (technical && operationsCount === 0)"))
    );

    expect(emptyGamme).toContain("warnings.push");
    expect(emptyGamme).not.toContain("blockers.push");
  });

  it("saute le planning inexistant et rend l'AR accessible", () => {
    const source = read("src/module/commande-client/repository/commande-client.repository.ts");
    expect(source).toContain('skip_reason: "no_plannable_operations"');
    expect(source).toContain('nouveau_statut: "AR_PRET"');
    expect(source).toContain("has_plannable_operations: generatedOfs.some");
  });
});
