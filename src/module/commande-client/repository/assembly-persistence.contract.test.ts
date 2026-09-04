import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot } from "../../../__tests__/helpers/repo-paths";

const source = readFileSync(
  resolve(repoRoot, "src/module/commande-client/repository/commande-client.repository.ts"),
  "utf8"
);

describe("assembly requirement persistence contract", () => {
  it("keeps the shared shortage parameter numeric in both the value and status expressions", () => {
    const start = source.indexOf("export async function persistAndReserveAssemblyComponents");
    const end = source.indexOf("export async function allocateInternalContractOfs", start);
    const persistence = source.slice(start, end);

    expect(persistence).toContain("$15::numeric,$16");
    expect(persistence).toContain("CASE WHEN $15::numeric <= 0");
  });
});
