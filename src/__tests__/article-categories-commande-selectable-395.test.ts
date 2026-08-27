// #395 / BUG-CERP-0015 - referentiel des categories commandables.
// Le filtre de recherche et la creation depuis une commande doivent rester fermes sur le
// perimetre que le repository Commande sait valider et convertir sans ambiguite.
import { beforeAll, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../config/database", () => ({
  default: { query: dbMocks.query },
}));

import {
  commandeClientSelectableCategoryCodes,
  repoListArticleCategories,
} from "../module/stock/repository/stock.repository";
import type { StockArticleCategoryOption } from "../module/stock/types/stock.types";

describe("#395 / BUG-CERP-0015 - categories commandables", () => {
  let options: StockArticleCategoryOption[] = [];

  beforeAll(async () => {
    dbMocks.query.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("to_regclass('public.article_category_referential')")) {
        return { rows: [{ ok: true }] };
      }
      if (query.includes("FROM public.article_category_referential")) {
        return {
          rows: [
            { code: "piece_finie_fabriquee", label: "Pièce finie fabriquée", code_segment: "PLAN", stock_managed_default: true, piece_technique_required: true, commande_client_selectable: true, is_active: true, sort_order: 10 },
            { code: "matiere_premiere", label: "Matière première", code_segment: "MP", stock_managed_default: true, piece_technique_required: false, commande_client_selectable: false, is_active: true, sort_order: 20 },
            { code: "traitement_surface", label: "Traitement de surface", code_segment: "TRT", stock_managed_default: false, piece_technique_required: false, commande_client_selectable: false, is_active: true, sort_order: 30 },
            { code: "achat_revente", label: "Achat-revente", code_segment: "ACH", stock_managed_default: true, piece_technique_required: false, commande_client_selectable: false, is_active: true, sort_order: 40 },
            { code: "sous_traitance", label: "Sous-traitance", code_segment: "STA", stock_managed_default: false, piece_technique_required: false, commande_client_selectable: false, is_active: true, sort_order: 50 },
            { code: "achat_transforme", label: "Achat transformé", code_segment: "AHT", stock_managed_default: true, piece_technique_required: false, commande_client_selectable: false, is_active: true, sort_order: 60 },
          ],
        };
      }
      return { rows: [] };
    });
    options = await repoListArticleCategories();
  });

  it("expose les six categories metier du referentiel", () => {
    expect(options.map((option) => option.code).sort()).toEqual(
      [
        "achat_revente",
        "achat_transforme",
        "matiere_premiere",
        "piece_finie_fabriquee",
        "sous_traitance",
        "traitement_surface",
      ].sort()
    );
  });

  it("n'expose que la piece finie fabriquee a la creation depuis une commande", () => {
    const selectable = options.filter((option) => option.commande_client_selectable);
    expect(selectable.map((option) => option.code)).toEqual(["piece_finie_fabriquee"]);
  });

  it("n'exige un dossier technique que pour une piece finie fabriquee", () => {
    const requiring = options.filter((option) => option.piece_technique_required).map((option) => option.code);
    expect(requiring).toEqual(["piece_finie_fabriquee"]);
  });

  it("derive les codes commandables depuis le referentiel, sans liste parallele", () => {
    const derived = commandeClientSelectableCategoryCodes();
    const expected = options.filter((option) => option.commande_client_selectable).map((option) => option.code);
    expect(derived).toEqual(expected);
    expect(derived).toEqual(["piece_finie_fabriquee"]);
  });

  it("conserve un segment de code et un comportement stock pour chaque categorie", () => {
    for (const option of options) {
      expect(option.code_segment, `segment manquant pour ${option.code}`).toMatch(/^[A-Z]{2,5}$/);
      expect(typeof option.stock_managed_default, `stock_managed_default pour ${option.code}`).toBe("boolean");
    }
    const byCode = new Map(options.map((option) => [option.code, option]));
    expect(byCode.get("traitement_surface")?.stock_managed_default).toBe(false);
    expect(byCode.get("sous_traitance")?.stock_managed_default).toBe(false);
  });
});
