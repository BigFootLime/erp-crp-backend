/**
 * Rend le document d'OF dans un fichier, pour inspection visuelle.
 *
 *   npx ts-node --transpile-only scripts/render-of-document.ts <sortie.pdf> [variante]
 *
 * Variantes : `nominal`, `brouillon`, `obsolete`, `cent-phases`, `multi-affaires`.
 */

import { writeFileSync } from "node:fs";

import { buildOfDocumentPayload } from "../src/module/production/domain/of-document";
import {
  buildFixtureInput,
  FIXTURE_QUANTITE_BASE,
} from "../src/module/production/domain/__fixtures__/of-document.fixture";
import { renderOfDocument } from "../src/module/production/services/of-document-render";
import type { OfRevisionOperation } from "../src/module/production/domain/of-revision";
import type { OfDocumentBuildInput } from "../src/module/production/domain/of-document";

/** Les 5 familles du référentiel, DECOUPE incluse. */
const FAMILIES = ["T", "F", "TTRAD", "FTRAD", "DECOUPE"] as const;

/** Gel de centre de frais, comme la normalisation des gammes le produit. */
const CF = {
  cfCode: "FCN",
  cfRateId: "c0000000-0000-4000-8000-000000000010",
  tauxHoraire: 68,
  tauxHoraireSource: "CENTRE_FRAIS",
  tauxHoraireEffectiveAt: "2026-01-01",
} as const;

function hundredPhases(): Partial<OfDocumentBuildInput> {
  const operations: OfRevisionOperation[] = Array.from({ length: 100 }, (_, index) => ({
    phase: (index + 1) * 10,
    designation: `OPERATION ${index + 1} — usinage et contrôle intermédiaire`,
    family: FAMILIES[index % FAMILIES.length],
    machineId: null,
    machineLabel: `MACHINE-${(index % 7) + 1}`,
    programme: `PGM-${String(index + 1).padStart(3, "0")}`,
    tempsUnitaire: 0.05 + (index % 9) / 100,
    preparation: (index % 5) * 0.25,
    quantiteBase: FIXTURE_QUANTITE_BASE,
    coefficient: 1,
    ...CF,
  }));

  const visas: OfDocumentBuildInput["visas"] = {};
  for (const operation of operations) {
    if (operation.phase % 30 === 0) {
      visas[operation.phase] = {
        statut: "VISE",
        visaOperateur: "AG",
        operateur: "A. GARNIER",
        visaAt: "2026-04-24T08:00:00.000Z",
        quantiteBonne: FIXTURE_QUANTITE_BASE,
        quantiteRebut: 0,
      };
    }
  }

  return { operations, visas };
}

/** Une seule phase : contrôle du cas dégénéré de pagination. */
function unePhase(): Partial<OfDocumentBuildInput> {
  return {
    operations: [
      {
        phase: 10,
        designation: "TOURNAGE CN COMPLET",
        family: "T",
        machineId: null,
        machineLabel: "TCN-1",
        programme: "P-UNIQUE",
        tempsUnitaire: 0.25,
        preparation: 1.5,
        quantiteBase: FIXTURE_QUANTITE_BASE,
        coefficient: 1,
        ...CF,
      },
    ],
    visas: {},
  };
}

/**
 * T -> F -> T : les trois passages doivent rester distincts sur la ligne de
 * séquence machines. Les regrouper effacerait le retour en tournage.
 */
function tft(): Partial<OfDocumentBuildInput> {
  return {
    operations: [
      { phase: 10, designation: "TOURNAGE CN", family: "T", machineId: null, machineLabel: "TCN-1", programme: "P-T-1", tempsUnitaire: 0.1, preparation: 1, quantiteBase: 10, coefficient: 1, ...CF, cfCode: "TCN" },
      { phase: 20, designation: "FRAISAGE CN", family: "F", machineId: null, machineLabel: "VMC-1", programme: "P-F-1", tempsUnitaire: 0.2, preparation: 1, quantiteBase: 10, coefficient: 1, ...CF },
      { phase: 30, designation: "REPRISE TOURNAGE", family: "T", machineId: null, machineLabel: "TCN-1", programme: "P-T-2", tempsUnitaire: 0.15, preparation: 1, quantiteBase: 10, coefficient: 1, ...CF, cfCode: "TCN" },
    ],
    visas: {},
  };
}

/**
 * Programme manquant sur une famille qui l'exige : le document doit le SIGNALER
 * et non laisser la case vide (critère d'acceptation #370).
 */
function programmeManquant(): Partial<OfDocumentBuildInput> {
  return {
    operations: [
      { phase: 10, designation: "FRAISAGE CN SANS PROGRAMME", family: "F", machineId: null, machineLabel: "VMC-1", programme: null, tempsUnitaire: 0.2, preparation: 1, quantiteBase: 10, coefficient: 1, ...CF },
      { phase: 20, designation: "DEBIT", family: "DECOUPE", machineId: null, machineLabel: "Scie", programme: null, tempsUnitaire: 0.05, preparation: 0, quantiteBase: 10, coefficient: 1, ...CF, cfCode: "DEB" },
    ],
    visas: {},
    // Découpe incomplète : la longueur totale ne doit PAS être déduite.
    decoupe: {
      dimensions: null,
      longueurBrutMm: null,
      longueurUtileMm: null,
      traitDeScieMm: null,
      chuteMm: null,
      nombreBruts: null,
      piecesParBrut: 1,
      masseTotaleKg: null,
      unite: null,
      methodeCalcul: null,
    },
  };
}

function multiAffaires(): Partial<OfDocumentBuildInput> {
  return {
    commandeNumero: "CF00042720 1 / CF00042955 2",
    affaires: [
      { affaireId: 23149, numero: "23 149", delaiClient: "2026-07-01", quantite: 40 },
      { affaireId: 23150, numero: "23 150", delaiClient: "2026-08-15", quantite: 25 },
      { affaireId: 23151, numero: "23 151", delaiClient: "2026-09-30", quantite: 35 },
    ],
    cadenceLivraison: [
      { date: "2026-07-01", quantite: 40, affaireNumero: "23 149" },
      { date: "2026-08-15", quantite: 25, affaireNumero: "23 150" },
      { date: "2026-09-30", quantite: 35, affaireNumero: "23 151" },
    ],
    quantites: {
      quantiteDemandee: 100,
      quantiteLivree: 10,
      stockReserve: 15,
      couvertAutresOf: 20,
      quantiteAffecteeCetOf: 40,
    },
  };
}

async function main(): Promise<void> {
  const out = process.argv[2] ?? "of-document.pdf";
  const variant = process.argv[3] ?? "nominal";

  const VARIANTS: Record<string, () => Partial<OfDocumentBuildInput>> = {
    nominal: () => ({ documentStatut: "OFFICIEL" }),
    brouillon: () => ({
      watermark: "BROUILLON",
      revisionStatut: "BROUILLON",
      ofStatut: "Brouillon",
      documentStatut: "BROUILLON",
    }),
    obsolete: () => ({
      watermark: "OBSOLETE",
      revisionStatut: "OBSOLETE",
      revisionCode: "R00",
      documentStatut: "OBSOLETE",
    }),
    "cent-phases": hundredPhases,
    "une-phase": unePhase,
    "multi-affaires": multiAffaires,
    tft,
    "programme-manquant": programmeManquant,
  };

  const build = VARIANTS[variant];
  if (!build) {
    throw new Error(`Variante inconnue : ${variant}. Connues : ${Object.keys(VARIANTS).join(", ")}`);
  }
  const overrides = build();

  const payload = buildOfDocumentPayload(buildFixtureInput(overrides));
  const result = await renderOfDocument(payload);
  writeFileSync(out, result.buffer);

  process.stdout.write(
    `${out}\n  variante : ${variant}\n  octets   : ${result.byteSize}\n  sha256   : ${result.sha256}\n` +
      `  phases   : ${payload.phases.length}\n  sequence : ${payload.sequenceMachinesLabel}\n` +
      `  totaux   : TP ${payload.totaux.preparationLabel} | TF ${payload.totaux.fabricationLabel} | ${payload.totaux.finalLabel}\n` +
      `  gabarit  : ${payload.templateVersion}\n` +
      `  signale  : ${payload.avertissements.length ? payload.avertissements.map((a) => a.code).join(", ") : "aucun"}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
