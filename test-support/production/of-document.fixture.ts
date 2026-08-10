// Jeu d'essai calqué sur une gamme de fabrication réelle de l'atelier :
// OF de l'affaire 23 149, pièce 45 252 966 B « BOITIER T16E M2 SANS PIETAGE ».
//
// Les temps sont ceux du document papier. Ils servent de contrôle : la règle
// `fabrication = temps_unitaire x quantité_base x coefficient` doit redonner
// exactement les TF imprimés, et leur somme les totaux 12,00 / 59,00 / 71,00 h.

import type { MachineFamilyRef, OfRevisionOperation } from "../../src/module/production/domain/of-revision";
import type { OfDocumentBuildInput } from "../../src/module/production/domain/of-document";

export const FIXTURE_QUANTITE_BASE = 40;

/**
 * Référentiel des familles machine, tel que `production_machine_families` le
 * porte en base après la normalisation des gammes.
 *
 * `programmeRequis` n'est vrai que pour les familles CN : c'est ce qui rend
 * légitime l'absence de n° de programme sur une découpe ou un emballage, et
 * illégitime sur un fraisage CN.
 */
export const FIXTURE_FAMILLES: MachineFamilyRef[] = [
  { code: "T", libelle: "Tournage CN", programmeRequis: true, ordreAffichage: 10, actif: true },
  { code: "F", libelle: "Fraisage CN", programmeRequis: true, ordreAffichage: 20, actif: true },
  { code: "TTRAD", libelle: "Tour conventionnel", programmeRequis: false, ordreAffichage: 30, actif: true },
  { code: "FTRAD", libelle: "Fraisage conventionnel", programmeRequis: false, ordreAffichage: 40, actif: true },
  { code: "DECOUPE", libelle: "Découpe", programmeRequis: false, ordreAffichage: 50, actif: true },
];

/** Valeurs de centre de frais communes, pour ne pas répéter cinq champs par ligne. */
function cf(code: string | null, taux: number | null): Pick<
  OfRevisionOperation,
  "cfCode" | "cfRateId" | "tauxHoraire" | "tauxHoraireSource" | "tauxHoraireEffectiveAt"
> {
  return {
    cfCode: code,
    cfRateId: code ? `c0000000-0000-4000-8000-0000000000${code.length}0` : null,
    tauxHoraire: taux,
    tauxHoraireSource: code ? "CENTRE_FRAIS" : null,
    tauxHoraireEffectiveAt: code ? "2026-01-01" : null,
  };
}

/**
 * Phases de la gamme réelle : découpe, 8 fraisages CN, gravure, emballage.
 *
 * La phase 20 porte désormais la famille `DECOUPE` : elle existe au référentiel
 * depuis la normalisation des gammes. La laisser sans famille la ferait
 * disparaître de la séquence machines alors que le débit est bien un passage.
 * L'emballage, lui, reste sans famille — ce n'est pas un poste d'usinage.
 */
export const FIXTURE_OPERATIONS: OfRevisionOperation[] = [
  { phase: 20, designation: "DECOUPE", family: "DECOUPE", machineId: null, machineLabel: "Scie", programme: null, tempsUnitaire: 0.08, preparation: 0, quantiteBase: FIXTURE_QUANTITE_BASE, coefficient: 1, ...cf("DEB", 42) },
  { phase: 30, designation: "FRAISAGE CN", family: "F", machineId: null, machineLabel: "VMC-1", programme: "45-252-966-B-1", tempsUnitaire: 0.1, preparation: 0.5, quantiteBase: FIXTURE_QUANTITE_BASE, coefficient: 1, ...cf("FCN", 68) },
  { phase: 40, designation: "FRAISAGE CN", family: "F", machineId: null, machineLabel: "VMC-1", programme: "45-252-966-B-2", tempsUnitaire: 0.2, preparation: 1, quantiteBase: FIXTURE_QUANTITE_BASE, coefficient: 1, ...cf("FCN", 68) },
  { phase: 50, designation: "FRAISAGE CN", family: "F", machineId: null, machineLabel: "VMC-2", programme: "45-252-966-B-3", tempsUnitaire: 0.25, preparation: 1, quantiteBase: FIXTURE_QUANTITE_BASE, coefficient: 1, ...cf("FCN", 68) },
  { phase: 60, designation: "FRAISAGE CN", family: "F", machineId: null, machineLabel: "VMC-2", programme: "45-252-966-B-4", tempsUnitaire: 0.17, preparation: 2, quantiteBase: FIXTURE_QUANTITE_BASE, coefficient: 1, ...cf("FCN", 68) },
  { phase: 70, designation: "FRAISAGE CN", family: "F", machineId: null, machineLabel: "VMC-2", programme: "45-252-966-B-5", tempsUnitaire: 0.2, preparation: 2, quantiteBase: FIXTURE_QUANTITE_BASE, coefficient: 1, ...cf("FCN", 68) },
  { phase: 80, designation: "FRAISAGE CN - GRAVURE", family: "F", machineId: null, machineLabel: "VM10", programme: "45252966-A-GRAV", tempsUnitaire: 0.035, preparation: 0.5, quantiteBase: FIXTURE_QUANTITE_BASE, coefficient: 1, ...cf("FCN", 68) },
  { phase: 90, designation: "FRAISAGE CN", family: "F", machineId: null, machineLabel: "VMC-1", programme: "45-252-966-B-6", tempsUnitaire: 0.16, preparation: 2, quantiteBase: FIXTURE_QUANTITE_BASE, coefficient: 1, ...cf("FCN", 68) },
  { phase: 100, designation: "FRAISAGE CN", family: "F", machineId: null, machineLabel: "VMC-1", programme: "45-252-966-B-7", tempsUnitaire: 0.1, preparation: 2, quantiteBase: FIXTURE_QUANTITE_BASE, coefficient: 1, ...cf("FCN", 68) },
  { phase: 110, designation: "FRAISAGE CN", family: "F", machineId: null, machineLabel: "VMC-1", programme: "45-252-966-B-8", tempsUnitaire: 0.1, preparation: 1, quantiteBase: FIXTURE_QUANTITE_BASE, coefficient: 1, ...cf("FCN", 68) },
  { phase: 120, designation: "EMBALLAGE EXPEDITION", family: null, machineId: null, machineLabel: null, programme: null, tempsUnitaire: 0.08, preparation: 0, quantiteBase: FIXTURE_QUANTITE_BASE, coefficient: 1, ...cf("EXP", 35) },
];

/** TF attendus du document papier, phase par phase. */
export const FIXTURE_EXPECTED_TF: Record<number, number> = {
  20: 3.2, 30: 4, 40: 8, 50: 10, 60: 6.8, 70: 8,
  80: 1.4, 90: 6.4, 100: 4, 110: 4, 120: 3.2,
};

export const FIXTURE_EXPECTED_TOTAL_TP = 12;
export const FIXTURE_EXPECTED_TOTAL_TF = 59;
export const FIXTURE_EXPECTED_TOTAL = 71;

/** VISA relevés sur le document papier. Toutes les phases n'en portent pas. */
export const FIXTURE_VISAS: OfDocumentBuildInput["visas"] = {
  30: { statut: "VISE", visaOperateur: "AG", operateur: "A. GARNIER", visaAt: "2026-04-24T08:00:00.000Z", quantiteBonne: 40, quantiteRebut: 0 },
  40: { statut: "VISE", visaOperateur: "AG", operateur: "A. GARNIER", visaAt: "2026-04-24T09:00:00.000Z", quantiteBonne: 40, quantiteRebut: 0 },
  50: { statut: "VISE", visaOperateur: "AG", operateur: "A. GARNIER", visaAt: "2026-04-24T10:00:00.000Z", quantiteBonne: 40, quantiteRebut: 0 },
  60: { statut: "VISE", visaOperateur: "TB", operateur: "T. BERNARD", visaAt: "2026-04-25T08:00:00.000Z", quantiteBonne: 39, quantiteRebut: 1, motifRebut: "Cote hors tolérance" },
  70: { statut: "VISE", visaOperateur: "TB", operateur: "T. BERNARD", visaAt: "2026-04-25T09:00:00.000Z", quantiteBonne: 39, quantiteRebut: 0 },
  80: { statut: "VISE", visaOperateur: "AG", operateur: "A. GARNIER", visaAt: "2026-04-25T10:00:00.000Z", quantiteBonne: 39, quantiteRebut: 0 },
  90: { statut: "VISE", visaOperateur: "TB", operateur: "T. BERNARD", visaAt: "2026-04-26T08:00:00.000Z", quantiteBonne: 39, quantiteRebut: 0 },
  100: { statut: "VISE", visaOperateur: "TB", operateur: "T. BERNARD", visaAt: "2026-04-26T09:00:00.000Z", quantiteBonne: 39, quantiteRebut: 0 },
  110: { statut: "VISE", visaOperateur: "TB", visaControle: "MC", operateur: "T. BERNARD", visaAt: "2026-04-26T10:00:00.000Z", quantiteBonne: 39, quantiteRebut: 0, commentaire: "Contrôle final OK" },
};

/**
 * Séquence T -> F -> T : deux tournages séparés par un fraisage.
 *
 * Cas de contrôle du regroupement : les trois passages doivent rester distincts.
 * Les regrouper en « 2 T -> 1 F » effacerait le retour en tournage, qui est
 * précisément l'information que l'atelier lit sur cette ligne.
 */
export const FIXTURE_OPERATIONS_TFT: OfRevisionOperation[] = [
  { phase: 10, designation: "TOURNAGE CN", family: "T", machineId: null, machineLabel: "TCN-1", programme: "P-T-1", tempsUnitaire: 0.1, preparation: 1, quantiteBase: 10, coefficient: 1, ...cf("TCN", 62) },
  { phase: 20, designation: "FRAISAGE CN", family: "F", machineId: null, machineLabel: "VMC-1", programme: "P-F-1", tempsUnitaire: 0.2, preparation: 1, quantiteBase: 10, coefficient: 1, ...cf("FCN", 68) },
  { phase: 30, designation: "REPRISE TOURNAGE", family: "T", machineId: null, machineLabel: "TCN-1", programme: "P-T-2", tempsUnitaire: 0.15, preparation: 1, quantiteBase: 10, coefficient: 1, ...cf("TCN", 62) },
];

export function buildFixtureInput(
  overrides: Partial<OfDocumentBuildInput> = {}
): OfDocumentBuildInput {
  return {
    ofNumero: "OF-2026-23149",
    revisionCode: "R00",
    revisionStatut: "ACTIVE",
    ofStatut: "En cours",
    snapshotId: "0f9b1c22-5f1a-4c6e-9d0a-6b7d2e3f4a51",
    snapshotSha256: "a".repeat(64),
    auteur: "Méthodes",
    generatedAt: "2026-04-23T06:30:00.000Z",
    watermark: null,

    commandeNumero: "CF00042720 1",
    clientCode: "003",
    clientNom: "AIRBUS HELICOPTERS",
    affaires: [
      { affaireId: 23149, numero: "23 149", delaiClient: "2026-07-01", quantite: 40 },
    ],
    cadenceLivraison: [
      { date: "2026-07-01", quantite: 40, affaireNumero: "23 149" },
    ],
    quantites: {
      quantiteDemandee: 40,
      quantiteLivree: 0,
      stockReserve: 0,
      couvertAutresOf: 0,
      quantiteAffecteeCetOf: 40,
    },
    cadenceProduction: [{ date: "2026-06-20", quantite: 40, affaireNumero: "23 149" }],
    derniereFabrication: { numero: "19689", date: "2024-03-26" },

    pieceReference: "45 252 966 B",
    pieceDesignation: "BOITIER T16E M2 SANS PIETAGE — SPEC 60 101 266-069 E",
    pieceIndice: "B",
    gammeCode: "GAMME-45252966",
    gammeVersion: "1",
    documentsAFournir: [
      "BL certifié",
      "CCPU matière",
      "Certificat de traitement",
      "Rapport de contrôle / PV",
    ],
    matiere: {
      reference: "PL*6061*T651*1*25*12",
      designation: "ALUMINIUM 6061/T651 1 X 25 EP 12",
      nuance: "6061/T651",
    },
    decoupe: {
      dimensions: "1 x 25 ep. 12",
      longueurBrutMm: 57,
      longueurUtileMm: 54,
      traitDeScieMm: 3,
      chuteMm: 0,
      nombreBruts: 40,
      piecesParBrut: 1,
      masseTotaleKg: 0.91,
      unite: "MM",
      methodeCalcul: null,
    },

    operations: FIXTURE_OPERATIONS,
    visas: FIXTURE_VISAS,
    familles: FIXTURE_FAMILLES,
    ...overrides,
  };
}
