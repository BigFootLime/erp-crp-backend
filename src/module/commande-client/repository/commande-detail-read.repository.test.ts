import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createCommandeDetailReadRepository } from "./commande-detail-read.repository";

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
});
