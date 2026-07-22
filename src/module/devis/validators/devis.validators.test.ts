import { describe, expect, it } from "vitest";
import { convertDevisBodySchema, createDevisBodySchema, updateDevisBodySchema } from "./devis.validators";

/**
 * #167 — matrice de robustesse du contrat d'entrée Devis : > 100 combinaisons
 * valides, limites et malformées. Le schéma est la première ligne de défense
 * (le repository re-vérifie ensuite automate, fraîcheur, idempotence).
 */

type Case = {
  label: string;
  payload: Record<string, unknown>;
  valid: boolean;
};

const baseLigne = { description: "Pièce fraisée", quantite: 2, prix_unitaire_ht: 125.5, remise_ligne: 5, taux_tva: 20 };
const base = {
  client_id: "001",
  user_id: 1,
  statut: "BROUILLON",
  lignes: [baseLigne],
};

function withLigne(over: Record<string, unknown>): Record<string, unknown> {
  return { ...base, lignes: [{ ...baseLigne, ...over }] };
}

const cases: Case[] = [];
const push = (label: string, payload: Record<string, unknown>, valid: boolean) => cases.push({ label, payload, valid });

// --- Quantité (positive stricte, coercion nombre) ---
const quantites: Array<[unknown, boolean]> = [
  [undefined, true], // défaut 1
  [1, true],
  [0.5, true],
  [999999, true],
  ["3", true], // coercion
  [0, false],
  [-3, false],
  ["abc", false],
];
for (const [value, valid] of quantites) push(`quantite=${String(value)}`, withLigne({ quantite: value }), valid);

// --- Prix unitaire HT (>= 0, requis) ---
const prix: Array<[unknown, boolean]> = [
  [0, true],
  [0.01, true],
  [123.45, true],
  [999999.99, true],
  ["49.9", true],
  [-0.01, false],
  ["x", false],
  [undefined, false],
];
for (const [value, valid] of prix) push(`prix=${String(value)}`, withLigne({ prix_unitaire_ht: value }), valid);

// --- Remise ligne (0..100) ---
const remises: Array<[unknown, boolean]> = [
  [undefined, true],
  [0, true],
  [50, true],
  [100, true],
  [100.01, false],
  [-1, false],
];
for (const [value, valid] of remises) push(`remise=${String(value)}`, withLigne({ remise_ligne: value }), valid);

// --- TVA (0..100, défaut 20) ---
const tvas: Array<[unknown, boolean]> = [
  [undefined, true],
  [0, true],
  [5.5, true],
  [20, true],
  [100, true],
  [101, false],
  [-1, false],
];
for (const [value, valid] of tvas) push(`tva=${String(value)}`, withLigne({ taux_tva: value }), valid);

// --- Désignation (non vide après trim) ---
const descriptions: Array<[unknown, boolean]> = [
  ["Pièce", true],
  ["", false],
  ["   ", false],
  [undefined, false],
];
for (const [value, valid] of descriptions) push(`description=${JSON.stringify(value)}`, withLigne({ description: value }), valid);

// --- Alias designation -> description (préprocesseur) ---
push("designation alias", { ...base, lignes: [{ designation: "Alias OK", quantite: 1, prix_unitaire_ht: 10 }] }, true);

// --- client_id (legacy 3 chiffres accepté tel quel, jamais transformé ; non vide) ---
const clients: Array<[unknown, boolean]> = [
  ["001", true],
  ["123", true],
  ["C-EX", true], // bridge additif : chaîne non vide tolérée par le contrat serveur
  ["", false],
  ["   ", false],
  [undefined, false],
];
for (const [value, valid] of clients) push(`client_id=${JSON.stringify(value)}`, { ...base, client_id: value }, valid);

// --- Dates (YYYY-MM-DD strict) ---
const dates: Array<[unknown, boolean]> = [
  [undefined, true],
  ["2026-08-01", true],
  ["", false], // le préprocesseur convertit en null mais le schéma interne exige la date
  ["01/08/2026", false],
  ["not-a-date", false],
  ["2026-8-1", false],
];
for (const [value, valid] of dates) push(`date_validite=${JSON.stringify(value)}`, { ...base, date_validite: value }, valid);

// --- Statuts : canoniques + alias normalisés (le repo restreint ensuite la naissance) ---
for (const statut of ["BROUILLON", "ENVOYE", "ACCEPTE", "REFUSE", "EXPIRE", "ANNULE", "brouillon", "envoyé", "accepté", "draft"]) {
  push(`statut=${statut}`, { ...base, statut }, true);
}

// --- Lignes (au moins une à la création) ---
push("lignes=[]", { ...base, lignes: [] }, false);
push("lignes absentes", { client_id: "001", user_id: 1, statut: "BROUILLON" }, false);
push(
  "25 lignes valides",
  { ...base, lignes: Array.from({ length: 25 }, (_, i) => ({ ...baseLigne, description: `Ligne ${i + 1}` })) },
  true
);

// --- Identifiants techniques (UUID stricts) ---
const uuids: Array<[unknown, boolean]> = [
  ["44444444-4444-4444-4444-444444444444", true],
  [null, true],
  ["pas-un-uuid", false],
  [42, false],
];
for (const [value, valid] of uuids) push(`article_id=${JSON.stringify(value)}`, withLigne({ article_id: value }), valid);
for (const [value, valid] of uuids) push(`contact_id=${JSON.stringify(value)}`, { ...base, contact_id: value }, valid);

// --- Numéro : indication d'affichage (30 max) — l'immutabilité est re-vérifiée serveur ---
push("numero fourni", { ...base, numero: "DEV-2026-0001" }, true);
push("numero vide rejeté", { ...base, numero: "" }, false);
push("numero trop long", { ...base, numero: "X".repeat(31) }, false);

// --- Remise globale (>= 0) ---
for (const [value, valid] of [
  [undefined, true],
  [0, true],
  [15, true],
  [-2, false],
] as Array<[unknown, boolean]>) {
  push(`remise_globale=${String(value)}`, { ...base, remise_globale: value }, valid);
}

// --- Grille croisée quantité × prix (49 combinaisons limites) ---
const qGrid: Array<[unknown, boolean]> = [
  [1, true],
  [0.001, true],
  [1000000, true],
  ["7", true],
  [0, false],
  [-1, false],
  ["NaN", false],
];
const pGrid: Array<[unknown, boolean]> = [
  [0, true],
  [0.01, true],
  [55, true],
  ["120.5", true],
  [-5, false],
  ["prix", false],
  [undefined, false],
];
for (const [q, qOk] of qGrid) {
  for (const [p, pOk] of pGrid) {
    push(`grille q=${String(q)} p=${String(p)}`, withLigne({ quantite: q, prix_unitaire_ht: p }), qOk && pOk);
  }
}

describe("#167 — matrice de payloads createDevisBodySchema", () => {
  it("couvre plus de 100 combinaisons valides, limites et malformées", () => {
    expect(cases.length).toBeGreaterThan(100);
  });

  for (const c of cases) {
    it(`${c.valid ? "accepte" : "rejette"} ${c.label}`, () => {
      const parsed = createDevisBodySchema.safeParse(c.payload);
      expect(parsed.success).toBe(c.valid);
    });
  }

  it("normalise les alias de statut vers l'enum canonique", () => {
    const parsed = createDevisBodySchema.safeParse({ ...base, statut: "accepté" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.statut).toBe("ACCEPTE");
  });

  it("applique les défauts numériques (quantite 1, tva 20, remise 0)", () => {
    const parsed = createDevisBodySchema.safeParse({
      ...base,
      lignes: [{ description: "L", prix_unitaire_ht: 10 }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lignes[0]).toMatchObject({ quantite: 1, taux_tva: 20, remise_ligne: 0 });
    }
  });
});

describe("#167 — updateDevisBodySchema (verrou optimiste additif)", () => {
  it("accepte expected_updated_at non vide et rejette la chaîne vide (jeton sans valeur)", () => {
    const withToken = updateDevisBodySchema.safeParse({ expected_updated_at: "2026-07-22T08:00:00+00:00" });
    expect(withToken.success).toBe(true);
    if (withToken.success) expect(withToken.data.expected_updated_at).toBe("2026-07-22T08:00:00+00:00");

    expect(updateDevisBodySchema.safeParse({ expected_updated_at: "" }).success).toBe(false);
    expect(updateDevisBodySchema.safeParse({}).success).toBe(true);
  });

  it("reste partiel : un payload vide est accepté par le schéma (le repo exige au moins un champ)", () => {
    expect(updateDevisBodySchema.safeParse({}).success).toBe(true);
  });
});

describe("#167 — convertDevisBodySchema", () => {
  it("tolère l'absence de corps et porte expected_updated_at", () => {
    expect(convertDevisBodySchema.parse(undefined)).toEqual({});
    expect(convertDevisBodySchema.parse({})).toEqual({});
    expect(convertDevisBodySchema.parse({ expected_updated_at: "2026-07-22T08:00:00+00:00" })).toEqual({
      expected_updated_at: "2026-07-22T08:00:00+00:00",
    });
  });
});
