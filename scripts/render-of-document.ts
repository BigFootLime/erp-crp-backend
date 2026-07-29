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

const FAMILIES = ["T", "F", "TTRAD", "FTRAD"] as const;

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
  }));

  const visas: OfDocumentBuildInput["visas"] = {};
  for (const operation of operations) {
    if (operation.phase % 30 === 0) {
      visas[operation.phase] = { initials: "AG", visaAt: "2026-04-24T08:00:00.000Z" };
    }
  }

  return { operations, visas };
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

  const overrides: Partial<OfDocumentBuildInput> =
    variant === "brouillon"
      ? { watermark: "BROUILLON", revisionStatut: "BROUILLON", ofStatut: "Brouillon" }
      : variant === "obsolete"
        ? { watermark: "OBSOLETE", revisionStatut: "OBSOLETE", revisionCode: "R00" }
        : variant === "cent-phases"
          ? hundredPhases()
          : variant === "multi-affaires"
            ? multiAffaires()
            : {};

  const payload = buildOfDocumentPayload(buildFixtureInput(overrides));
  const result = await renderOfDocument(payload);
  writeFileSync(out, result.buffer);

  process.stdout.write(
    `${out}\n  variante : ${variant}\n  octets   : ${result.byteSize}\n  sha256   : ${result.sha256}\n  phases   : ${payload.phases.length}\n  totaux   : TP ${payload.totaux.preparationLabel} | TF ${payload.totaux.fabricationLabel} | ${payload.totaux.finalLabel}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
