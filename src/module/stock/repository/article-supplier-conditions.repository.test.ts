import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ update: vi.fn(), create: vi.fn() }));
vi.mock("../../fournisseurs/repository/fournisseurs.repository", () => ({
  repoUpdateFournisseurCatalogueItem: mocks.update,
  repoCreateFournisseurCatalogueItem: mocks.create,
}));
import { syncArticleSupplierConditionsTx } from "./article-supplier-conditions.repository";

const condition = { supplier_id:"supplier", catalogue_id:"catalogue", preferred:false,
  unite:"u", unite_stock:"u", coef_conversion:1, prix_unitaire:8, expected_catalogue_updated_at:"v1" };
beforeEach(() => { vi.resetAllMocks(); mocks.update.mockResolvedValue({id:"catalogue",actif:true}); });

describe("conditions fournisseur depuis la fiche article", () => {
  it.each(["MATIERE", "SOUS_TRAITANCE", "CONSOMMABLE", "AUTRE"])("conserve le type %s et les tarifs de la même référence", async type => {
    const tx={query:vi.fn(async(sql:string) => ({rows:sql.includes("FROM public.articles")
      ? [{designation:"Article test",unite:"u",catalogue_type:type}] : [{id:"catalogue",version:"v1"}]}))};
    await syncArticleSupplierConditionsTx(tx as never,"article",[{...condition,forfait_ht:20,minimum_facturation_ht:100,price_tiers:[]}],{user_id:1} as never);
    expect(mocks.update).toHaveBeenCalledWith("supplier","catalogue",expect.objectContaining({type,article_id:"article",forfait_ht:20,minimum_facturation_ht:100}),expect.anything(),tx);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("refuse l’écrasement d’un tarif modifié par un AR après l’ouverture de la fiche", async () => {
    const tx={query:vi.fn(async(sql:string) => ({rows:sql.includes("FROM public.articles")
      ? [{designation:"Article test",unite:"u",catalogue_type:"SOUS_TRAITANCE"}] : [{id:"catalogue",version:"v2"}]}))};
    await expect(syncArticleSupplierConditionsTx(tx as never,"article",[condition],{user_id:1} as never)).rejects.toMatchObject({code:"ARTICLE_CATALOGUE_CHANGED"});
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
