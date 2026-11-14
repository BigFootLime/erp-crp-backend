import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import ts from "typescript";
import type { Pool } from "pg";
import { createCommandeListReadRepository } from "./commande-list-read.repository";
import { listCommandesQuerySchema } from "../validators/commande-client.validators";

describe("commande list read owner", () => {
  it("preserves count/data query order, pagination defaults and mapped integer ids", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: "42", numero: "CMD-42" }] });
    const owner = createCommandeListReadRepository({
      pool: { query } as unknown as Pool,
      normalizedCommandeStatusSql: vi.fn(() => "'ATTENTE_STOCK'"), toInt: (value) => Number(value),
    });
    await expect(owner.repoListCommandes({ page: 2, pageSize: 5, sortBy: "numero", sortDir: "asc", client_id: "client-1" })).resolves.toEqual({ items: [{ id: 42, numero: "CMD-42" }], total: 1 });
    expect(query.mock.calls).toHaveLength(2);
    expect(query.mock.calls[0][1]).toEqual(["client-1"]);
    expect(query.mock.calls[1][1]).toEqual(["client-1", 5, 5]);
  });

  it("binds every real filter in the same count/data order without interpolating search text", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [] });
    const owner = createCommandeListReadRepository({
      pool: { query } as unknown as Pool,
      normalizedCommandeStatusSql: () => "canonical_status(st.nouveau_statut)", toInt: value => Number(value),
    });
    const search = "x%' OR 1=1 --";
    await owner.repoListCommandes(listCommandesQuerySchema.parse({
      q: ` ${search} `, client_id: " client-1 ", statut: " ATTENTE_STOCK ", order_type: "FERME",
      from: " 2026-01-01 ", to: " 2026-12-31 ", min_total_ttc: 12, max_total_ttc: 40,
      mine_recent: true, page: 3, pageSize: 7, sortBy: "total_ttc", sortDir: "desc",
    }));
    const values = [`%${search}%`, "client-1", "ATTENTE_STOCK", "FERME", "2026-01-01", "2026-12-31", 12, 40];
    expect(query.mock.calls[0][1]).toEqual(values);
    expect(query.mock.calls[1][1]).toEqual([...values, 7, 14]);
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toContain(search);
      expect(sql).toContain("canonical_status(st.nouveau_statut)");
      expect(sql).toContain("cc.updated_at >= (now() - interval '30 days')");
      expect(sql).toContain("cc.date_commande >= $5::date");
      expect(sql).toContain("cc.date_commande <= $6::date");
      expect(sql).toContain("cc.total_ttc >= $7");
      expect(sql).toContain("cc.total_ttc <= $8");
    }
    expect(query.mock.calls[1][0]).toContain("ORDER BY cc.total_ttc DESC");
    expect(query.mock.calls[1][0]).toContain("LIMIT $9");
    expect(query.mock.calls[1][0]).toContain("OFFSET $10");
  });

  it("keeps default ordering/pagination and an absent count as an empty result", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const owner = createCommandeListReadRepository({
      pool: { query } as unknown as Pool, normalizedCommandeStatusSql: () => "status", toInt: value => Number(value),
    });
    await expect(owner.repoListCommandes(listCommandesQuerySchema.parse({ q: " ", client_id: " ", statut: " ", from: " ", to: " " })))
      .resolves.toEqual({ items: [], total: 0 });
    expect(query.mock.calls[0][1]).toEqual([]);
    expect(query.mock.calls[1][1]).toEqual([20, 0]);
    expect(query.mock.calls[1][0]).toContain("ORDER BY cc.updated_at DESC");
  });

  it.each([
    ["numero", "cc.numero"], ["date_commande", "cc.date_commande"],
    ["updated_at", "cc.updated_at"], ["total_ttc", "cc.total_ttc"],
  ] as const)("keeps both directions of the %s sort whitelist", async (sortBy, column) => {
    for (const sortDir of ["asc", "desc"] as const) {
      const query = vi.fn().mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [] });
      const owner = createCommandeListReadRepository({
        pool: { query } as unknown as Pool, normalizedCommandeStatusSql: () => "status", toInt: value => Number(value),
      });
      await owner.repoListCommandes(listCommandesQuerySchema.parse({ sortBy, sortDir }));
      expect(query.mock.calls[1][0]).toContain(`ORDER BY ${column} ${sortDir.toUpperCase()}`);
    }
  });

  it("does not query data after a count failure and retains a data failure", async () => {
    const countError = new Error("count failed");
    const countQuery = vi.fn().mockRejectedValueOnce(countError);
    const countOwner = createCommandeListReadRepository({
      pool: { query: countQuery } as unknown as Pool, normalizedCommandeStatusSql: () => "status", toInt: value => Number(value),
    });
    await expect(countOwner.repoListCommandes(listCommandesQuerySchema.parse({}))).rejects.toBe(countError);
    expect(countQuery).toHaveBeenCalledTimes(1);
    const dataError = new Error("data failed");
    const dataQuery = vi.fn().mockResolvedValueOnce({ rows: [{ total: 3 }] }).mockRejectedValueOnce(dataError);
    const dataOwner = createCommandeListReadRepository({
      pool: { query: dataQuery } as unknown as Pool, normalizedCommandeStatusSql: () => "status", toInt: value => Number(value),
    });
    await expect(dataOwner.repoListCommandes(listCommandesQuerySchema.parse({}))).rejects.toBe(dataError);
    expect(dataQuery).toHaveBeenCalledTimes(2);
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
    for (const name of ["sortColumn", "sortDirection", "buildListWhere"]) {
      expect(body(owner, name, name === "buildListWhere")).toBe(body(base, name));
    }
  });

  it("preserves invocation-time pool lookup in the actual public facade function", async () => {
    const facade = readFileSync(path.join(process.cwd(), "src/module/commande-client/repository/commande-client.repository.ts"), "utf8");
    const ast = ts.createSourceFile("facade.ts", facade, ts.ScriptTarget.Latest, true);
    const wrapper = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "repoListCommandes");
    expect(wrapper).toBeDefined();
    const eagerBinding = ast.statements.find(statement => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "commandeListReadRepository"));
    const exported: { repoListCommandes?: ReturnType<typeof createCommandeListReadRepository>["repoListCommandes"] } = {};
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [] });
    let poolReads = 0;
    const sandbox = {
      exports: exported, createCommandeListReadRepository,
      normalizedCommandeStatusSql: () => "status", toInt: (value: string | number) => Number(value),
    };
    Object.defineProperty(sandbox, "pool", { get: () => { poolReads++; return { query }; } });
    const actualDeclarations = [eagerBinding?.getText(ast), wrapper!.getText(ast)].filter(Boolean).join("\n");
    const code = ts.transpileModule(actualDeclarations, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(code, sandbox);
    expect(poolReads).toBe(0);
    await expect(exported.repoListCommandes!(listCommandesQuerySchema.parse({}))).resolves.toEqual({ items: [], total: 0 });
    expect(poolReads).toBe(1);
  });
});
