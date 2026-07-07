import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// GPAO — le cluster legacy `piece_technique` / `operation_technique` / `achat_technique`
// est DÉPRÉCIÉ (ADR pieces-techniques-gpao-target-model). La source canonique est
// `pieces_techniques` (pluriel) et son écosystème. Ce garde empêche tout NOUVEL usage de ces
// tables legacy dans le code applicatif (SQL FROM/JOIN/INTO/UPDATE/DELETE), en attendant leur
// suppression physique (P4). Aujourd'hui : 0 usage — ce test verrouille l'état.

const SRC_DIR = path.resolve(__dirname, "..");

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.(ts|js)$/.test(entry)) out.push(full);
  }
  return out;
}

// Nom de table legacy en position SQL (FROM/JOIN/INTO/UPDATE/DELETE FROM), au singulier.
// Le `\b` après le nom évite de matcher `piece_technique_id` (colonne, suivie de `_id`) et
// le pluriel `pieces_techniques` (pas de "piece_technique" sans "s" devant le "_").
const LEGACY = ["piece_technique", "operation_technique", "achat_technique"];
const FORBIDDEN = LEGACY.map((t) => ({
  table: t,
  re: new RegExp(String.raw`\b(from|join|into|update|delete\s+from)\s+(public\.)?${t}\b(?!_)`, "is"),
}));

describe("GPAO — pas de nouvel usage des tables Pièces techniques legacy", () => {
  const files = collectSourceFiles(SRC_DIR);

  it("a des fichiers source à scanner", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("n'utilise aucune table legacy (piece_technique/operation_technique/achat_technique) en SQL", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sql = readFileSync(file, "utf8");
      for (const { table, re } of FORBIDDEN) {
        if (re.test(sql)) offenders.push(`${path.relative(SRC_DIR, file)} :: ${table}`);
      }
    }
    expect(
      offenders,
      `Tables legacy dépréciées — utilise pieces_techniques (pluriel). Offenders:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
