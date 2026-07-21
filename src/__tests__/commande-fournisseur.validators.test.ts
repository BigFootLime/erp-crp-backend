import { describe, expect, it } from "vitest";

import {
  accuseSchema,
  createCommandeSchema,
  ligneInputSchema,
  listCommandesQuerySchema,
  propositionsConfirmSchema,
  simulateTotauxSchema,
  transitionSchema,
  updateCommandeSchema,
} from "../module/commande-fournisseur/validators/commande-fournisseur.validators";

const UUID = "3b9f2a44-6d3e-4f7a-9c2d-1e5b8a7c6d90";

const baseLigne = {
  type: "ARTICLE",
  article_id: UUID,
  designation: "Rond acier 42CD4 Ø30",
  quantite: 12,
  prix_unitaire_ht: 8.5,
};

const baseCreate = {
  fournisseur_id: UUID,
  devise: "EUR",
  lignes: [baseLigne],
};

describe("validators commandes fournisseurs (#172) — Zod strict", () => {
  it("accepte une création minimale valide et applique les défauts serveur", () => {
    const parsed = createCommandeSchema.parse({ body: baseCreate });
    expect(parsed.body.origine).toBe("MANUEL");
    expect(parsed.body.frais_port_ht).toBe(0);
    expect(parsed.body.lignes[0].tva_pct).toBe(20);
    expect(parsed.body.lignes[0].remise_pct).toBe(0);
  });

  it("rejette tout champ inconnu (mode strict, création et PATCH)", () => {
    expect(() => createCommandeSchema.parse({ body: { ...baseCreate, code: "BCF-2026-9999" } })).toThrow();
    expect(() => createCommandeSchema.parse({ body: { ...baseCreate, statut: "APPROUVEE" } })).toThrow();
    expect(() => createCommandeSchema.parse({ body: { ...baseCreate, total_ttc: 1 } })).toThrow();
    expect(() => updateCommandeSchema.parse({ body: { code: "BCF-2026-0001" } })).toThrow();
    expect(() => updateCommandeSchema.parse({ body: { statut: "ENVOYEE" } })).toThrow();
  });

  it("le code n'est jamais accepté du client (immuable, généré serveur)", () => {
    expect("code" in createCommandeSchema.shape.body.shape).toBe(false);
    expect("code" in updateCommandeSchema.shape.body.shape).toBe(false);
    expect("statut" in updateCommandeSchema.shape.body.shape).toBe(false);
  });

  it("exige article ou catalogue pour les lignes non libres, et conversion complète", () => {
    expect(() =>
      ligneInputSchema.parse({ ...baseLigne, article_id: undefined, catalogue_id: undefined })
    ).toThrow(/article ou une entrée de catalogue/i);
    // LIBRE_CONTROLEE passe sans article
    expect(() =>
      ligneInputSchema.parse({ type: "LIBRE_CONTROLEE", designation: "Prestation gravure", quantite: 1, prix_unitaire_ht: 50 })
    ).not.toThrow();
    // conversion incomplète refusée
    expect(() => ligneInputSchema.parse({ ...baseLigne, coef_conversion: 2 })).toThrow(/Conversion/i);
    expect(() => ligneInputSchema.parse({ ...baseLigne, unite_stock: "kg" })).toThrow(/Conversion/i);
    expect(() => ligneInputSchema.parse({ ...baseLigne, unite_stock: "kg", coef_conversion: 2.5 })).not.toThrow();
  });

  it("borne pagination, tri et filtres de liste", () => {
    const q = listCommandesQuerySchema.parse({ query: {} }).query;
    expect(q).toMatchObject({ page: 1, page_size: 25, sort: "created_at", dir: "desc" });
    expect(() => listCommandesQuerySchema.parse({ query: { page_size: "500" } })).toThrow();
    expect(() => listCommandesQuerySchema.parse({ query: { sort: "evil_column" } })).toThrow();
    expect(() => listCommandesQuerySchema.parse({ query: { statut: "N_IMPORTE_QUOI" } })).toThrow();
    expect(() => listCommandesQuerySchema.parse({ query: { injection: "1;DROP TABLE" } })).toThrow();
  });

  it("transition : statut contrôlé par enum, jamais de chaîne arbitraire", () => {
    expect(() => transitionSchema.parse({ body: { to: "ENVOYEE" } })).not.toThrow();
    expect(() => transitionSchema.parse({ body: { to: "SUPPRIMEE" } })).toThrow();
    expect(() => transitionSchema.parse({ body: { to: "ENVOYEE", extra: true } })).toThrow();
  });

  it("accusé : référence fournisseur obligatoire, dates au bon format", () => {
    expect(() => accuseSchema.parse({ body: { reference_fournisseur: "AR-778812" } })).not.toThrow();
    expect(() => accuseSchema.parse({ body: {} })).toThrow();
    expect(() =>
      accuseSchema.parse({ body: { reference_fournisseur: "AR-1", date_promesse: "21/07/2026" } })
    ).toThrow();
  });

  it("propositions/confirm : clé d'idempotence obligatoire et bornée", () => {
    const groupe = {
      fournisseur_id: UUID,
      devise: "EUR",
      lignes: [
        { besoin_type: "STOCK_LEVEL", besoin_ref: UUID, designation: "Insert carbure", quantite: 10, type: "ARTICLE" },
      ],
    };
    expect(() =>
      propositionsConfirmSchema.parse({ body: { idempotency_key: "k".repeat(16), groupes: [groupe] } })
    ).not.toThrow();
    expect(() => propositionsConfirmSchema.parse({ body: { groupes: [groupe] } })).toThrow();
    expect(() => propositionsConfirmSchema.parse({ body: { idempotency_key: "court", groupes: [groupe] } })).toThrow();
  });

  it("simulate : lignes bornées à 200", () => {
    const ligne = { quantite: 1, prix_unitaire_ht: 1 };
    expect(() => simulateTotauxSchema.parse({ body: { lignes: Array(200).fill(ligne) } })).not.toThrow();
    expect(() => simulateTotauxSchema.parse({ body: { lignes: Array(201).fill(ligne) } })).toThrow();
  });

  it("résiste à 140 variantes valides / manquantes / limites / malformées sans crash", () => {
    type Variant = { payload: unknown; valid: boolean };
    const variants: Variant[] = [];

    // 40 variantes valides (quantités/prix/remises/TVA aux limites)
    for (let i = 0; i < 40; i += 1) {
      variants.push({
        valid: true,
        payload: {
          ...baseCreate,
          origine: (["MANUEL", "SEUIL_STOCK", "RUPTURE_OF", "SOUS_TRAITANCE"] as const)[i % 4],
          frais_port_ht: (i % 7) * 10.55,
          tva_frais_pct: i % 2 ? 20 : 5.5,
          lignes: [
            {
              ...baseLigne,
              quantite: i === 0 ? 0.001 : (i % 13) + 0.5,
              prix_unitaire_ht: (i * 997) % 10000 === 0 ? 0 : ((i * 997) % 10000) / 100,
              remise_pct: i % 5 === 0 ? 100 : (i % 5) * 12.5,
              tva_pct: i % 3 === 0 ? 0 : 20,
              date_besoin: i % 2 ? "2026-08-15" : undefined,
            },
          ],
        },
      });
    }

    // 100 variantes invalides : champ par champ, hors bornes, mal typé, inconnu, malformé
    const invalidLignePatches: Array<Record<string, unknown>> = [
      { quantite: 0 },
      { quantite: -5 },
      { quantite: "douze" },
      { quantite: Number.NaN },
      { quantite: Infinity },
      { quantite: 10_000_000_000 },
      { prix_unitaire_ht: -1 },
      { prix_unitaire_ht: "gratuit" },
      { remise_pct: 101 },
      { remise_pct: -0.01 },
      { tva_pct: 250 },
      { frais_ht: -3 },
      { designation: "" },
      { designation: "x".repeat(201) },
      { type: "CADEAU" },
      { article_id: "pas-un-uuid" },
      { catalogue_id: 42 },
      { date_besoin: "2026-13-45" },
      { date_besoin: "hier" },
      { delai_jours: -1 },
      { delai_jours: 3.7 },
      { of_id: "OF-12" },
      { affaire_id: -8 },
      { exigences_qualite: [{ type: "INCONNU" }] },
      { documents_attendus: [""] },
      { champ_pirate: true },
      { besoins: [{ besoin_type: "MANUEL", besoin_ref: "", quantite_couverte: 1 }] },
      { besoins: [{ besoin_type: "STOCK_LEVEL", besoin_ref: UUID, quantite_couverte: 0 }] },
      { unite: "x".repeat(21) },
      { coef_conversion: 0 },
    ];
    for (const patch of invalidLignePatches) {
      variants.push({ valid: false, payload: { ...baseCreate, lignes: [{ ...baseLigne, ...patch }] } });
    }
    const invalidHeaderPatches: Array<Record<string, unknown>> = [
      { fournisseur_id: "42" },
      { fournisseur_id: null },
      { devise: "EURO" },
      { devise: "" },
      { incoterm: "XXX" },
      { origine: "IMPORT_CLIPPER" },
      { frais_port_ht: -10 },
      { tva_frais_pct: 120 },
      { commentaire_public: "x".repeat(4001) },
      { idempotency_key: "abc" },
      { lignes: "aucune" },
      { lignes: Array(201).fill(baseLigne) },
      { date_besoin: "2026/07/21" },
      { note_interne: 12345 },
      { contact_id: "contact-1" },
      { magasin_livraison_id: "MAG1" },
      { adresse_livraison_texte: "x".repeat(4001) },
      { mode_transport: "x".repeat(121) },
      { conditions_paiement: "x".repeat(201) },
      { code: "BCF-2026-0001" },
    ];
    for (const patch of invalidHeaderPatches) {
      variants.push({ valid: false, payload: { ...baseCreate, ...patch } });
    }
    // 50 payloads structurellement malformés
    const malformed: unknown[] = [
      null,
      undefined,
      [],
      "BCF",
      42,
      true,
      { lignes: [baseLigne] }, // fournisseur manquant
      {},
      { fournisseur_id: UUID, lignes: [null] },
      { fournisseur_id: UUID, lignes: [[]] },
    ];
    for (let i = 0; i < 50; i += 1) {
      variants.push({ valid: false, payload: malformed[i % malformed.length] });
    }

    expect(variants.length).toBeGreaterThanOrEqual(140);
    let validCount = 0;
    let invalidCount = 0;
    for (const variant of variants) {
      const result = createCommandeSchema.safeParse({ body: variant.payload });
      if (variant.valid) {
        expect(result.success, `attendu valide: ${JSON.stringify(variant.payload).slice(0, 120)}`).toBe(true);
        validCount += 1;
      } else {
        expect(result.success, `attendu rejeté: ${JSON.stringify(variant.payload)?.slice(0, 120)}`).toBe(false);
        invalidCount += 1;
      }
    }
    expect(validCount).toBe(40);
    expect(invalidCount).toBeGreaterThanOrEqual(100);
  });
});
