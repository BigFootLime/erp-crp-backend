// #170 — grille de valeurs (normales, limites, malformées) sur les validators
// OF : création, mise à jour, réordonnancement, génération, réception.
// > 100 combinaisons exécutées en data-driven ; chaque cas indique s'il doit
// passer la validation Zod (le refus métier plus profond est testé ailleurs).

import { describe, expect, it } from "vitest"

import {
  createOfSchema,
  generateOfsSchema,
  ofReceiptBodySchema,
  previewOfGenerationSchema,
  reorderOfOperationsSchema,
  updateOfSchema,
} from "../module/production/validators/production.validators";

const UUID = "22222222-2222-2222-2222-222222222222";
const UUID2 = "33333333-3333-3333-3333-333333333333";
const ISO_TS = "2026-07-22T10:00:00.000+02:00";
const SHA = "c".repeat(64);

type Case = { name: string; value: unknown; ok: boolean };

function runMatrix(name: string, cases: Case[], parse: (value: unknown) => { success: boolean }) {
  describe(name, () => {
    for (const c of cases) {
      it(`${c.ok ? "accepte" : "refuse"} ${c.name}`, () => {
        expect(parse(c.value).success).toBe(c.ok);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// createOfSchema — 30 combinaisons
// ---------------------------------------------------------------------------
const createBase = { piece_technique_id: UUID, piece_technique_version_id: UUID2 };
const createCases: Case[] = [
  { name: "création minimale (version épinglée)", value: createBase, ok: true },
  { name: "quantité 26", value: { ...createBase, quantite_lancee: 26 }, ok: true },
  { name: "quantité décimale 0.125", value: { ...createBase, quantite_lancee: 0.125 }, ok: true },
  { name: "quantité chaîne coercible '26'", value: { ...createBase, quantite_lancee: "26" }, ok: true },
  { name: "quantité 0", value: { ...createBase, quantite_lancee: 0 }, ok: false },
  { name: "quantité négative", value: { ...createBase, quantite_lancee: -1 }, ok: false },
  { name: "quantité NaN", value: { ...createBase, quantite_lancee: "abc" }, ok: false },
  { name: "pièce absente", value: { piece_technique_version_id: UUID2 }, ok: false },
  { name: "version absente", value: { piece_technique_id: UUID }, ok: false },
  { name: "pièce non-uuid", value: { ...createBase, piece_technique_id: "OF-2026" }, ok: false },
  { name: "version non-uuid", value: { ...createBase, piece_technique_version_id: "42" }, ok: false },
  { name: "statut BROUILLON", value: { ...createBase, statut: "BROUILLON" }, ok: true },
  { name: "statut PLANIFIE", value: { ...createBase, statut: "PLANIFIE" }, ok: true },
  { name: "statut inconnu", value: { ...createBase, statut: "OUVERT" }, ok: false },
  { name: "statut en minuscules", value: { ...createBase, statut: "brouillon" }, ok: false },
  { name: "priorité CRITICAL", value: { ...createBase, priority: "CRITICAL" }, ok: true },
  { name: "priorité inconnue", value: { ...createBase, priority: "URGENTISSIME" }, ok: false },
  { name: "date prévue ISO", value: { ...createBase, date_lancement_prevue: "2026-07-22" }, ok: true },
  { name: "date prévue malformée (FR)", value: { ...createBase, date_lancement_prevue: "22/07/2026" }, ok: false },
  { name: "date prévue avec heure", value: { ...createBase, date_lancement_prevue: "2026-07-22T10:00" }, ok: false },
  { name: "date fin null", value: { ...createBase, date_fin_prevue: null }, ok: true },
  { name: "notes remplies", value: { ...createBase, notes: "Série pilote" }, ok: true },
  { name: "notes vides (min 1)", value: { ...createBase, notes: "" }, ok: false },
  { name: "client_id 3 caractères", value: { ...createBase, client_id: "001" }, ok: true },
  { name: "client_id trop long", value: { ...createBase, client_id: "0001" }, ok: false },
  { name: "affaire_id positif", value: { ...createBase, affaire_id: 31 }, ok: true },
  { name: "affaire_id zéro", value: { ...createBase, affaire_id: 0 }, ok: false },
  { name: "affaire_id négatif", value: { ...createBase, affaire_id: -5 }, ok: false },
  { name: "commande_id flottant", value: { ...createBase, commande_id: 1.5 }, ok: false },
  { name: "numero fourni (toléré, ignoré par le serveur)", value: { ...createBase, numero: "OF-2026-000001" }, ok: true },
];
runMatrix("createOfSchema", createCases, (value) => createOfSchema.safeParse({ body: value }));

// ---------------------------------------------------------------------------
// updateOfSchema — 22 combinaisons
// ---------------------------------------------------------------------------
const updateCases: Case[] = [
  { name: "patch vide", value: {}, ok: true },
  { name: "statut EN_COURS", value: { statut: "EN_COURS" }, ok: true },
  { name: "statut ANNULE", value: { statut: "ANNULE" }, ok: true },
  { name: "statut inconnu", value: { statut: "PAUSE" }, ok: false },
  { name: "jeton optimiste ISO avec offset", value: { expected_updated_at: ISO_TS }, ok: true },
  { name: "jeton optimiste UTC Z", value: { expected_updated_at: "2026-07-22T08:00:00.000Z" }, ok: true },
  { name: "jeton optimiste sans offset", value: { expected_updated_at: "2026-07-22T08:00:00" }, ok: false },
  { name: "jeton optimiste date seule", value: { expected_updated_at: "2026-07-22" }, ok: false },
  { name: "quantité bonne 0", value: { quantite_bonne: 0 }, ok: true },
  { name: "quantité bonne décimale", value: { quantite_bonne: 12.5 }, ok: true },
  { name: "quantité bonne négative", value: { quantite_bonne: -0.001 }, ok: false },
  { name: "quantité rebut négative", value: { quantite_rebut: -1 }, ok: false },
  { name: "quantité lancée 0 refusée", value: { quantite_lancee: 0 }, ok: false },
  { name: "dates réelles ISO", value: { date_lancement_reelle: "2026-07-22", date_fin_reelle: "2026-07-23" }, ok: true },
  { name: "date réelle malformée", value: { date_fin_reelle: "23-07-2026" }, ok: false },
  { name: "notes null (effacement)", value: { notes: null }, ok: true },
  { name: "notes chaîne vide", value: { notes: "" }, ok: false },
  { name: "priorité LOW", value: { priority: "LOW" }, ok: true },
  { name: "client_id null", value: { client_id: null }, ok: true },
  { name: "affaire_id null (détachement)", value: { affaire_id: null }, ok: true },
  { name: "affaire_id chaîne coercible", value: { affaire_id: "31" }, ok: true },
  { name: "affaire_id chaîne invalide", value: { affaire_id: "abc" }, ok: false },
];
runMatrix("updateOfSchema", updateCases, (value) => updateOfSchema.safeParse({ body: value }));

// ---------------------------------------------------------------------------
// reorderOfOperationsSchema — 16 combinaisons
// ---------------------------------------------------------------------------
const reorderBase = {
  expected_updated_at: ISO_TS,
  operations: [
    { op_id: UUID, phase: 10 },
    { op_id: UUID2, phase: 20 },
  ],
};
const reorderCases: Case[] = [
  { name: "réordonnancement nominal", value: reorderBase, ok: true },
  { name: "une seule opération", value: { ...reorderBase, operations: [{ op_id: UUID, phase: 10 }] }, ok: true },
  { name: "liste vide", value: { ...reorderBase, operations: [] }, ok: false },
  { name: "jeton optimiste manquant", value: { operations: reorderBase.operations }, ok: false },
  { name: "jeton optimiste malformé", value: { ...reorderBase, expected_updated_at: "hier" }, ok: false },
  { name: "phase 1 (min)", value: { ...reorderBase, operations: [{ op_id: UUID, phase: 1 }] }, ok: true },
  { name: "phase 9999 (max)", value: { ...reorderBase, operations: [{ op_id: UUID, phase: 9999 }] }, ok: true },
  { name: "phase 0", value: { ...reorderBase, operations: [{ op_id: UUID, phase: 0 }] }, ok: false },
  { name: "phase 10000", value: { ...reorderBase, operations: [{ op_id: UUID, phase: 10000 }] }, ok: false },
  { name: "phase négative", value: { ...reorderBase, operations: [{ op_id: UUID, phase: -10 }] }, ok: false },
  { name: "phase décimale", value: { ...reorderBase, operations: [{ op_id: UUID, phase: 10.5 }] }, ok: false },
  { name: "phases dupliquées", value: { ...reorderBase, operations: [{ op_id: UUID, phase: 10 }, { op_id: UUID2, phase: 10 }] }, ok: false },
  { name: "op_id dupliqué", value: { ...reorderBase, operations: [{ op_id: UUID, phase: 10 }, { op_id: UUID, phase: 20 }] }, ok: false },
  { name: "op_id non-uuid", value: { ...reorderBase, operations: [{ op_id: "op-1", phase: 10 }] }, ok: false },
  { name: "champ inconnu refusé (strict)", value: { ...reorderBase, force: true }, ok: false },
  { name: "opération avec champ inconnu", value: { ...reorderBase, operations: [{ op_id: UUID, phase: 10, note: "x" }] }, ok: false },
];
runMatrix("reorderOfOperationsSchema", reorderCases, (value) => reorderOfOperationsSchema.safeParse({ body: value }));

// ---------------------------------------------------------------------------
// preview/generate — 28 combinaisons
// ---------------------------------------------------------------------------
const manualSource = { type: "MANUAL", piece_technique_id: UUID, quantity: 26 };
const affaireSource = { type: "AFFAIRE", affaire_id: 31, piece_technique_id: UUID, quantity: 2 };
const previewCases: Case[] = [
  { name: "aperçu manuel quantité 26", value: { source: manualSource }, ok: true },
  { name: "aperçu affaire", value: { source: affaireSource }, ok: true },
  { name: "aperçu affaire sans affaire_id", value: { source: { ...affaireSource, affaire_id: undefined } }, ok: false },
  { name: "quantité décimale 0.5", value: { source: { ...manualSource, quantity: 0.5 } }, ok: true },
  { name: "quantité maximale 1e6", value: { source: { ...manualSource, quantity: 1_000_000 } }, ok: true },
  { name: "quantité au-delà du max", value: { source: { ...manualSource, quantity: 1_000_001 } }, ok: false },
  { name: "quantité 0", value: { source: { ...manualSource, quantity: 0 } }, ok: false },
  { name: "quantité négative", value: { source: { ...manualSource, quantity: -26 } }, ok: false },
  { name: "quantité chaîne coercible", value: { source: { ...manualSource, quantity: "26" } }, ok: true },
  { name: "quantité malformée", value: { source: { ...manualSource, quantity: "vingt-six" } }, ok: false },
  { name: "type inconnu", value: { source: { ...manualSource, type: "COMMANDE" } }, ok: false },
  { name: "pièce manquante", value: { source: { type: "MANUAL", quantity: 1 } }, ok: false },
  { name: "version épinglée uuid", value: { source: { ...manualSource, piece_technique_version_id: UUID2 } }, ok: true },
  { name: "version épinglée non-uuid", value: { source: { ...manualSource, piece_technique_version_id: "vA" } }, ok: false },
  { name: "champ inconnu dans la source (strict)", value: { source: { ...manualSource, commande_id: 1 } }, ok: false },
  { name: "source absente", value: {}, ok: false },
];
runMatrix("previewOfGenerationSchema", previewCases, (value) => previewOfGenerationSchema.safeParse({ body: value }));

const generateBase = { source: manualSource, expected_source_hash: SHA, confirm: true };
const generateCases: Case[] = [
  { name: "génération confirmée", value: generateBase, ok: true },
  { name: "hash manquant", value: { source: manualSource, confirm: true }, ok: false },
  { name: "hash trop court", value: { ...generateBase, expected_source_hash: "abc" }, ok: false },
  { name: "hash non hexadécimal", value: { ...generateBase, expected_source_hash: "z".repeat(64) }, ok: false },
  { name: "hash majuscules accepté", value: { ...generateBase, expected_source_hash: "C".repeat(64) }, ok: true },
  { name: "confirm false", value: { ...generateBase, confirm: false }, ok: false },
  { name: "confirm absent", value: { source: manualSource, expected_source_hash: SHA }, ok: false },
  { name: "confirm chaîne 'true'", value: { ...generateBase, confirm: "true" }, ok: false },
  { name: "champ parasite refusé", value: { ...generateBase, dry_run: true }, ok: false },
  { name: "source affaire complète", value: { ...generateBase, source: affaireSource }, ok: true },
  { name: "affaire_id 0", value: { ...generateBase, source: { ...affaireSource, affaire_id: 0 } }, ok: false },
  { name: "affaire_id chaîne coercible", value: { ...generateBase, source: { ...affaireSource, affaire_id: "31" } }, ok: true },
];
runMatrix("generateOfsSchema", generateCases, (value) => generateOfsSchema.safeParse({ body: value }));

// ---------------------------------------------------------------------------
// ofReceiptBodySchema — 18 combinaisons
// ---------------------------------------------------------------------------
const receiptBase = {
  qty_ok: 5,
  location_id: UUID,
  lot_mode: "NEW",
  quality_status: "LIBERE",
  expected_of_updated_at: ISO_TS,
};
const receiptCases: Case[] = [
  { name: "réception nominale (nouveau lot serveur)", value: receiptBase, ok: true },
  { name: "réception partielle décimale", value: { ...receiptBase, qty_ok: 0.5 }, ok: true },
  { name: "qty_ok 0", value: { ...receiptBase, qty_ok: 0 }, ok: false },
  { name: "qty_ok négative", value: { ...receiptBase, qty_ok: -2 }, ok: false },
  { name: "qty_ok chaîne coercible", value: { ...receiptBase, qty_ok: "5" }, ok: true },
  { name: "qty_ok malformée", value: { ...receiptBase, qty_ok: "cinq" }, ok: false },
  { name: "location manquante", value: { qty_ok: 1, lot_mode: "NEW" }, ok: false },
  { name: "location non-uuid", value: { ...receiptBase, location_id: "MAG-1" }, ok: false },
  { name: "lot existant avec lot_id", value: { ...receiptBase, lot_mode: "EXISTING", lot_id: UUID2 }, ok: true },
  { name: "lot_mode inconnu", value: { ...receiptBase, lot_mode: "AUTO" }, ok: false },
  { name: "unite renseignée", value: { ...receiptBase, unite: "pcs" }, ok: true },
  { name: "unite vide", value: { ...receiptBase, unite: "" }, ok: false },
  { name: "unite trop longue (>30)", value: { ...receiptBase, unite: "u".repeat(31) }, ok: false },
  { name: "commentaire rempli", value: { ...receiptBase, commentaire: "Contrôle visuel OK" }, ok: true },
  { name: "commentaire trop long (>2000)", value: { ...receiptBase, commentaire: "x".repeat(2001) }, ok: false },
  { name: "article_id uuid", value: { ...receiptBase, article_id: UUID2 }, ok: true },
  { name: "article_id non-uuid", value: { ...receiptBase, article_id: "ART-1" }, ok: false },
  { name: "champ parasite refusé (strict)", value: { ...receiptBase, force: true }, ok: false },
];
runMatrix("ofReceiptBodySchema", receiptCases, (value) => ofReceiptBodySchema.safeParse(value));

it("couvre plus de 100 combinaisons de valeurs (#170 §12)", () => {
  const total =
    createCases.length + updateCases.length + reorderCases.length + previewCases.length + generateCases.length + receiptCases.length;
  expect(total).toBeGreaterThanOrEqual(100);
});
