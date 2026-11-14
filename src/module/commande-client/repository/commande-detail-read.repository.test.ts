import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import ts from "typescript";
import type { Pool } from "pg";
import { createCommandeDetailReadRepository } from "./commande-detail-read.repository";
import { readCommandeContractCall } from "../../client/repository/client-contract-calls.repository";
import { readLegacyAssociation } from "../../client/repository/client-contract-legacy.repository";

vi.mock("../../client/repository/client-contract-calls.repository", () => ({
  readCommandeContractCall: vi.fn(async () => ({ lines: [{ commande_ligne_id: "11", contract_line_id: "cc-11" }] })),
}));
vi.mock("../../client/repository/client-contract-legacy.repository", () => ({
  readLegacyAssociation: vi.fn(async () => ({ contract_id: "legacy-1" })),
}));

const header = { id: "7", numero: "CMD-7", client_id: "client-7", devis_id: "8", source_devis_version_id: null, creation_flow_version: 2,
  contact_id: null, destinataire_id: null, adresse_facturation_id: null, emetteur: null, code_client: null, date_commande: "2026-01-01", arc_edi: false,
  arc_date_envoi: null, compteur_affaire_id: null, type_affaire: "STANDARD", order_type: "FERME", cadre_start_date: null, cadre_end_date: null,
  dest_stock_magasin_id: null, dest_stock_emplacement_id: null, mode_port_id: null, mode_reglement_id: null, conditions_paiement_id: null,
  delivery_prepayment_requirement: null, biller_id: null, compte_vente_id: null, commentaire: null, remise_globale: 0, total_ht: 1, total_ttc: 1,
  created_at: "2026-01-01", updated_at: "2026-01-01", statut: "BROUILLON" };

function owner(rows: unknown[][], hasRoleColumn = true) {
  const query = vi.fn();
  for (const rowsForQuery of rows) query.mockResolvedValueOnce({ rows: rowsForQuery });
  return {
    query,
    owner: createCommandeDetailReadRepository({
      pool: { query } as unknown as Pool,
      normalizedCommandeStatusSql: (column) => `STATUS(${column})`,
      toInt: (value, label = "id") => { if (typeof value === "number") return value; if (typeof value === "string" && /^\d+$/.test(value)) return Number(value); throw new Error(`Invalid ${label}: ${String(value)}`); },
      toNullableInt: (value, label) => value == null ? null : Number(value),
      hasCommandeToAffaireRoleColumn: vi.fn(async () => hasRoleColumn),
    }),
  };
}

describe("commande detail read owner", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it.each([
    ["lignes", [{ id: "11", commande_id: "7" }], /FROM commande_ligne/, /ORDER BY cl\.id ASC/],
    ["echeances", [{ id: "12", commande_id: "7" }], /FROM commande_echeance/, /ORDER BY date_echeance ASC, id ASC/],
    ["documents", [{ id: "13", commande_id: "7" }], /FROM commande_documents/, /ORDER BY cd\.id DESC/],
    ["historique", [{ id: "14", commande_id: "7", user_id: null }], /FROM commande_historique/, /ORDER BY date_action DESC, id DESC/],
    ["affaires", [{ id: "15", commande_id: "7", affaire_id: "16", affaire: { id: "16", commande_id: "7", devis_id: null } }], /FROM commande_to_affaire/, /ORDER BY cta\.date_conversion DESC, cta\.id DESC/],
    ["client", [{ client_id: "client-7" }], /FROM clients/, /WHERE client_id = \$1/],
  ])("loads %s only when requested and preserves query ordering", async (include, childRows, from, orderBy) => {
    const fixture = owner([[header], childRows]);
    const result = await fixture.owner.repoGetCommande("7", new Set([include]));
    expect(result).not.toBeNull();
    expect(fixture.query).toHaveBeenCalledTimes(2);
    expect(String(fixture.query.mock.calls[1]?.[0])).toMatch(from);
    expect(String(fixture.query.mock.calls[1]?.[0])).toMatch(orderBy);
    if (include === "lignes") expect(result?.lignes[0]).toMatchObject({ id: 11, commande_id: 7, client_contract_line_id: "cc-11" });
  });

  it("keeps contract and legacy reads, falls back when the role column is absent, and accepts a null client", async () => {
    const fixture = owner([[{ ...header, client_id: null }], [{ id: "15", commande_id: "7", affaire_id: "16", affaire: { id: "16", commande_id: "7", devis_id: null } }]], false);
    const result = await fixture.owner.repoGetCommande("7", new Set(["affaires", "client"]));
    expect(result?.commande.client_contract_legacy).toEqual({ contract_id: "legacy-1" });
    expect(result?.client).toBeNull();
    expect(fixture.query).toHaveBeenCalledTimes(2);
    expect(String(fixture.query.mock.calls[1]?.[0])).toContain("THEN 'LIVRAISON'");
  });

  it("preserves ID validation errors before issuing SQL", async () => {
    const fixture = owner([]);
    await expect(fixture.owner.repoGetCommande("not-an-id", new Set())).rejects.toThrow("Invalid commande_id");
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it("returns a missing header before contract, legacy or optional queries", async () => {
    const fixture = owner([[]]);
    await expect(fixture.owner.repoGetCommande("7", new Set(["lignes", "client"]))).resolves.toBeNull();
    expect(fixture.query).toHaveBeenCalledTimes(1);
    expect(readCommandeContractCall).not.toHaveBeenCalled();
    expect(readLegacyAssociation).not.toHaveBeenCalled();
  });

  const optional = ["lignes", "echeances", "documents", "historique", "affaires", "client"] as const;
  it.each(Array.from({ length: 64 }, (_, mask) => [mask]))("retains independent includes and ordered mappings for mask %i", async (mask) => {
    const includes = new Set(optional.filter((_, index) => (mask & (1 << index)) !== 0));
    const rows = {
      lignes: [{ id: "11", commande_id: "7", designation: "Part" }],
      echeances: [{ id: "12", commande_id: "7", montant: 1 }],
      documents: [{ id: "13", commande_id: "7", document: null }],
      historique: [{ id: "14", commande_id: "7", user_id: "9" }],
      affaires: [{ id: "15", commande_id: "7", affaire_id: "16", affaire: { id: "16", commande_id: "7", devis_id: null } }],
      client: [{ client_id: "client-7", company_name: "Client" }],
    };
    const fixture = owner([[header], ...optional.filter(key => includes.has(key)).map(key => rows[key])]);
    const result = await fixture.owner.repoGetCommande("7", includes);
    expect(result?.commande).toMatchObject({ id: 7, devis_id: 8, source_devis_version_id: null, creation_flow_version: 2 });
    expect(readCommandeContractCall).toHaveBeenCalledTimes(1);
    expect(readLegacyAssociation).toHaveBeenCalledTimes(1);
    expect(readCommandeContractCall).toHaveBeenCalledWith(expect.objectContaining({ query: fixture.query }), "7");
    expect(fixture.query).toHaveBeenCalledTimes(1 + includes.size);
    expect(fixture.query.mock.calls.map(call => call[1])).toEqual([
      [7], ...optional.filter(key => includes.has(key)).map(key => [key === "client" ? "client-7" : 7]),
    ]);
    expect(result?.lignes).toEqual(includes.has("lignes") ? [{ id: 11, commande_id: 7, designation: "Part", client_contract_line_id: "cc-11" }] : []);
    expect(result?.echeances).toEqual(includes.has("echeances") ? [{ id: 12, commande_id: 7, montant: 1 }] : []);
    expect(result?.documents).toEqual(includes.has("documents") ? [{ id: 13, commande_id: 7, document: null }] : []);
    expect(result?.historique).toEqual(includes.has("historique") ? [{ id: 14, commande_id: 7, user_id: 9 }] : []);
    expect(result?.affaires).toEqual(includes.has("affaires") ? [{ id: 15, commande_id: 7, affaire_id: 16, affaire: { id: 16, commande_id: 7, devis_id: null } }] : []);
    expect(result?.client).toEqual(includes.has("client") ? rows.client[0] : null);
  });

  it("propagates an optional read failure after the header without further reads", async () => {
    const failure = new Error("line read failed");
    const fixture = owner([[header]]);
    fixture.query.mockRejectedValueOnce(failure);
    await expect(fixture.owner.repoGetCommande("7", new Set(["lignes", "documents"]))).rejects.toBe(failure);
    expect(fixture.query).toHaveBeenCalledTimes(2);
  });

  it("resolves the imported pool only when the real public facade is invoked", async () => {
    const source = readFileSync(path.join(__dirname, "commande-client.repository.ts"), "utf8");
    const ast = ts.createSourceFile("facade.ts", source, ts.ScriptTarget.Latest, true);
    const wrappers = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "repoGetCommande");
    expect(wrappers).toHaveLength(1);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    let poolReads = 0;
    const exports: { repoGetCommande?: ReturnType<typeof createCommandeDetailReadRepository>["repoGetCommande"] } = {};
    const sandbox = {
      exports, createCommandeDetailReadRepository, normalizedCommandeStatusSql: () => "status",
      toInt: Number, toNullableInt: (value: unknown) => value == null ? null : Number(value),
      hasCommandeToAffaireRoleColumn: vi.fn(async () => true),
    };
    Object.defineProperty(sandbox, "pool", { get: () => { poolReads++; return { query }; } });
    const code = ts.transpileModule(wrappers[0].getText(ast), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(code, sandbox);
    expect(poolReads).toBe(0);
    await expect(exports.repoGetCommande!("7", new Set())).resolves.toBeNull();
    expect(poolReads).toBe(1);
  });
});
