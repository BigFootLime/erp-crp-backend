import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Pool } from "pg";
import { createCommandeListReadRepository } from "./commande-list-read.repository";

describe("commande list read owner", () => {
  it("preserves count/data query order, pagination defaults and mapped integer ids", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: "42", numero: "CMD-42" }] });
    const owner = createCommandeListReadRepository({
      pool: { query } as unknown as Pool,
      buildListWhere: vi.fn(() => ({ whereSql: "WHERE cc.client_id = $1", values: ["client-1"] })),
      sortColumn: vi.fn(() => "cc.numero"), sortDirection: vi.fn((): "ASC" => "ASC"),
      normalizedCommandeStatusSql: vi.fn(() => "'ATTENTE_STOCK'"), toInt: (value) => Number(value),
    });
    await expect(owner.repoListCommandes({ page: 2, pageSize: 5, sortBy: "numero", sortDir: "asc" })).resolves.toEqual({ items: [{ id: 42, numero: "CMD-42" }], total: 1 });
    expect(query.mock.calls).toHaveLength(2);
    expect(query.mock.calls[0][1]).toEqual(["client-1"]);
    expect(query.mock.calls[1][1]).toEqual(["client-1", 5, 5]);
  });
});

function body(source: string, name: string, nested = false) {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); };
  visit(file); if (!found?.body) throw new Error(name); return found.body.getText(file).replace(/\r\n/g, "\n").replace(nested ? /^  /gm : /$^/, "");
}

describe("commande list extraction proof", () => {
  it("preserves the base list SQL body and public wrapper signature", () => {
    const base = execFileSync("git", ["show", "21c49ce345c647830bc6b535ad0eaba81779091b:src/module/commande-client/repository/commande-client.repository.ts"], { encoding: "utf8" });
    const owner = readFileSync(path.join(process.cwd(), "src/module/commande-client/repository/commande-list-read.repository.ts"), "utf8");
    const facade = readFileSync(path.join(process.cwd(), "src/module/commande-client/repository/commande-client.repository.ts"), "utf8");
    expect(body(owner, "repoListCommandes", true)).toBe(body(base, "repoListCommandes"));
    expect(facade).toMatch(/export async function repoListCommandes\(filters: ListCommandesQueryDTO\)/);
    expect(facade).toContain("return commandeListReadRepository.repoListCommandes(filters);");
  });
});
