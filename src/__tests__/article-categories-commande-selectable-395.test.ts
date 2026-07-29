// #395 — Référentiel des catégories d'article : ce qui est VENDABLE en commande client.
//
// Ce référentiel est un contrat, pas une préférence d'affichage : le frontend l'utilise à la
// fois pour proposer les catégories à la création depuis une commande et pour filtrer la
// recherche d'article des lignes. Un `false` posé ici ferme les deux portes d'un coup.
import { beforeAll, describe, expect, it } from "vitest";

import {
  commandeClientSelectableCategoryCodes,
  repoListArticleCategories,
} from "../module/stock/repository/stock.repository";
import type { StockArticleCategoryOption } from "../module/stock/types/stock.types";

describe("#395 — catégories vendables en commande client", () => {
  let options: StockArticleCategoryOption[] = [];

  beforeAll(async () => {
    options = await repoListArticleCategories();
  });

  it("expose les six catégories métier du référentiel", () => {
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

  it("rend TOUTES les catégories vendables (élargissement #395)", () => {
    // Régression : seule `piece_finie_fabriquee` l'était, ce qui rendait la création d'article
    // depuis une commande inutilisable pour un achat, une sous-traitance ou un traitement.
    const notSellable = options.filter((option) => !option.commande_client_selectable);
    expect(notSellable.map((option) => option.code)).toEqual([]);
  });

  it("n'exige un dossier technique QUE pour une pièce finie fabriquée", () => {
    // L'élargissement de la vente ne doit pas propager l'obligation de dossier technique :
    // c'est lui qui produit les OF, et seule une pièce fabriquée en a un.
    const requiring = options.filter((option) => option.piece_technique_required).map((option) => option.code);
    expect(requiring).toEqual(["piece_finie_fabriquee"]);
  });

  it("dérive la liste des codes vendables depuis le référentiel, sans liste parallèle", () => {
    const derived = commandeClientSelectableCategoryCodes();
    const expected = options.filter((option) => option.commande_client_selectable).map((option) => option.code);
    expect(derived).toEqual(expected);
    expect(derived.length).toBeGreaterThan(0);
  });

  it("conserve un segment de code et un comportement stock pour chaque catégorie", () => {
    for (const option of options) {
      expect(option.code_segment, `segment manquant pour ${option.code}`).toMatch(/^[A-Z]{2,5}$/);
      expect(typeof option.stock_managed_default, `stock_managed_default pour ${option.code}`).toBe("boolean");
    }
    // Les services ne sont pas inventoriés : le référentiel doit continuer à le dire.
    const byCode = new Map(options.map((option) => [option.code, option]));
    expect(byCode.get("traitement_surface")?.stock_managed_default).toBe(false);
    expect(byCode.get("sous_traitance")?.stock_managed_default).toBe(false);
  });
});
