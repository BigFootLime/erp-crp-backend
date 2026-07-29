// Chantier #374 — document d'OF : read-model, instantané figé, rendu serveur.
//
// Le rendu est réellement produit et le texte relu dans les flux de contenu du
// PDF : c'est ce qui permet d'affirmer qu'une valeur y figure, plutôt que de
// l'espérer (même harnais que le bon de livraison, ADR-0042).

import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  buildMachineSequence,
  buildOfDocumentPayload,
  computeQuantityCoverage,
  formatDuration,
  formatMachineSequence,
  formatNumberFr,
  formatQuantity,
  watermarkFor,
} from "../module/production/domain/of-document";
import { hashSnapshot } from "../module/production/domain/of-revision";
import { renderOfDocument } from "../module/production/services/of-document-render";
import {
  buildFixtureInput,
  FIXTURE_EXPECTED_TOTAL,
  FIXTURE_EXPECTED_TOTAL_TF,
  FIXTURE_EXPECTED_TOTAL_TP,
  FIXTURE_QUANTITE_BASE,
} from "../module/production/domain/__fixtures__/of-document.fixture";
import type { OfRevisionOperation } from "../module/production/domain/of-revision";

/**
 * Texte réellement imprimé, relu dans les flux de contenu du PDF.
 *
 * `pdfkit` écrit les chaînes en hexadécimal et les découpe en fragments crénés :
 * « Page 2 / 2 » sort en `[<50> 30 <61> 10 <67> -10 <652032202f2032> 0] TJ`. Une
 * recherche naïve dans le binaire ne trouverait donc jamais le texte affiché. On
 * décode les opérateurs de rendu et on recolle les fragments, en écartant les
 * nombres de crénage.
 *
 * Les polices standard sont encodées en WinAnsi, dont les octets coïncident avec
 * latin1 sur les accents français.
 */
function pdfText(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  const streams: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw)) !== null) {
    try {
      streams.push(inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"));
    } catch {
      // Flux non compressé, image ou police : sans texte à relire.
    }
  }

  const content = streams.join("\n");
  const pieces: string[] = [];
  const showRe = /<([0-9A-Fa-f\s]+)>|\(((?:\\.|[^\\()])*)\)/g;
  while ((match = showRe.exec(content)) !== null) {
    if (match[1] !== undefined) {
      const hex = match[1].replace(/\s+/g, "");
      if (hex.length % 2 === 0) {
        pieces.push(Buffer.from(hex, "hex").toString("latin1"));
      }
    } else {
      pieces.push(
        match[2].replace(/\\([nrtbf()\\])/g, (_, char: string) =>
          char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char
        )
      );
    }
  }

  return pieces.join("");
}

function countPages(buffer: Buffer): number {
  const matches = buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

describe("#374 E — formatage du document", () => {
  it("affiche les durées comme on les dit à l'atelier", () => {
    expect(formatDuration(0.1)).toBe("6 min");
    expect(formatDuration(1.3333333)).toBe("1 h 20 min");
    expect(formatDuration(4)).toBe("4 h");
    expect(formatDuration(3.2)).toBe("3 h 12 min");
    expect(formatDuration(0.035)).toBe("2 min");
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(59)).toBe("59 h");
  });

  it("écrit les nombres à la française", () => {
    expect(formatNumberFr(2280)).toBe("2 280,00");
    expect(formatNumberFr(0.91, 3)).toBe("0,910");
    expect(formatQuantity(40)).toBe("40");
    expect(formatQuantity(40.5)).toBe("40,500");
    expect(formatQuantity(null)).toBe("—");
  });
});

describe("#374 E — couverture de la demande sans double comptage", () => {
  it("répartit la demande en postes disjoints dont la somme la redonne", () => {
    const coverage = computeQuantityCoverage({
      quantiteDemandee: 100,
      quantiteLivree: 10,
      stockReserve: 15,
      couvertAutresOf: 20,
      quantiteAffecteeCetOf: 40,
    });
    expect(coverage.resteNetACouvrir).toBe(15);
    expect(coverage.totalCouvert).toBe(85);
    expect(
      coverage.quantiteLivree +
        coverage.stockReserve +
        coverage.couvertAutresOf +
        coverage.quantiteAffecteeCetOf +
        coverage.resteNetACouvrir
    ).toBe(coverage.quantiteDemandee);
    expect(coverage.surCouverture).toBe(false);
  });

  it("ne compte pas deux fois une réservation et un autre OF actif", () => {
    // 40 demandés : 25 réservés sur stock et 15 produits ailleurs couvrent tout.
    const coverage = computeQuantityCoverage({
      quantiteDemandee: 40,
      quantiteLivree: 0,
      stockReserve: 25,
      couvertAutresOf: 15,
      quantiteAffecteeCetOf: 0,
    });
    expect(coverage.resteNetACouvrir).toBe(0);
    expect(coverage.totalCouvert).toBe(40);
  });

  it("borne le reste net à zéro et signale la sur-couverture", () => {
    const coverage = computeQuantityCoverage({
      quantiteDemandee: 40,
      quantiteLivree: 10,
      stockReserve: 20,
      couvertAutresOf: 20,
      quantiteAffecteeCetOf: 10,
    });
    expect(coverage.resteNetACouvrir).toBe(0);
    expect(coverage.surCouverture).toBe(true);
    expect(coverage.excedent).toBe(20);
  });

  it("neutralise les valeurs absentes ou négatives", () => {
    const coverage = computeQuantityCoverage({
      quantiteDemandee: 40,
      quantiteLivree: -5,
      stockReserve: Number.NaN,
      couvertAutresOf: null as unknown as number,
      quantiteAffecteeCetOf: 40,
    });
    expect(coverage.quantiteLivree).toBe(0);
    expect(coverage.stockReserve).toBe(0);
    expect(coverage.couvertAutresOf).toBe(0);
    expect(coverage.resteNetACouvrir).toBe(0);
  });
});

describe("#374 E — séquence machines", () => {
  const op = (phase: number, family: OfRevisionOperation["family"]) => ({ phase, family });

  it("conserve l'ordre réel : T -> F -> T reste trois passages", () => {
    const steps = buildMachineSequence([op(10, "T"), op(20, "F"), op(30, "T")]);
    expect(steps.map((s) => s.family)).toEqual(["T", "F", "T"]);
    expect(formatMachineSequence(steps)).toBe("T -> F -> T");
  });

  it("regroupe les phases consécutives d'une même famille", () => {
    const steps = buildMachineSequence([
      op(10, "F"), op(20, "F"), op(30, "F"), op(40, "T"), op(50, "T"), op(60, "F"),
    ]);
    expect(formatMachineSequence(steps)).toBe("3 F -> 2 T -> F");
    expect(steps[0].phases).toEqual([10, 20, 30]);
  });

  it("écarte les phases sans famille mais laisse la séquence se rouvrir", () => {
    // Fraisage, emballage, fraisage : la pièce retourne bien en machine.
    const steps = buildMachineSequence([op(10, "F"), op(20, null), op(30, "F")]);
    expect(steps.map((s) => s.family)).toEqual(["F", "F"]);
    expect(formatMachineSequence(steps)).toBe("F -> F");
  });

  it("porte les quatre familles", () => {
    const steps = buildMachineSequence([
      op(10, "T"), op(20, "F"), op(30, "TTRAD"), op(40, "FTRAD"),
    ]);
    expect(formatMachineSequence(steps)).toBe("T -> F -> TTRAD -> FTRAD");
  });

  it("rend une séquence vide lisible", () => {
    expect(formatMachineSequence(buildMachineSequence([]))).toBe("—");
    expect(formatMachineSequence(buildMachineSequence([op(10, null)]))).toBe("—");
  });
});

describe("#374 E — instantané et filigrane", () => {
  it("calcule la découpe sans inventer de valeur", () => {
    const payload = buildOfDocumentPayload(buildFixtureInput());
    expect(payload.decoupe.longueurTotaleMm).toBe(2280);

    const partiel = buildOfDocumentPayload(
      buildFixtureInput({ decoupe: { longueurBrutMm: 57, nombreBruts: null, piecesParBrut: 1, masseTotaleKg: null } })
    );
    expect(partiel.decoupe.longueurTotaleMm).toBeNull();
    expect(partiel.decoupe.masseTotaleKg).toBeNull();
  });

  it("totalise les temps du document papier", () => {
    const payload = buildOfDocumentPayload(buildFixtureInput());
    expect(payload.totaux.preparationH).toBeCloseTo(FIXTURE_EXPECTED_TOTAL_TP, 6);
    expect(payload.totaux.fabricationH).toBeCloseTo(FIXTURE_EXPECTED_TOTAL_TF, 6);
    expect(payload.totaux.finalH).toBeCloseTo(FIXTURE_EXPECTED_TOTAL, 6);
    expect(payload.totaux.finalLabel).toBe("71 h");
  });

  it("exige un filigrane sur un brouillon et sur une révision périmée", () => {
    expect(watermarkFor({ revisionStatut: "ACTIVE", documentStatut: "OFFICIEL" })).toBeNull();
    expect(watermarkFor({ revisionStatut: "ACTIVE", documentStatut: "BROUILLON" })).toBe("BROUILLON");
    expect(watermarkFor({ revisionStatut: "OBSOLETE", documentStatut: "OFFICIEL" })).toBe("OBSOLETE");
    expect(watermarkFor({ revisionStatut: "ACTIVE", documentStatut: "OBSOLETE" })).toBe("OBSOLETE");
  });

  it("produit le même payload — donc la même empreinte — à contenu égal", () => {
    const a = buildOfDocumentPayload(buildFixtureInput());
    const b = buildOfDocumentPayload(buildFixtureInput());
    expect(hashSnapshot(a)).toBe(hashSnapshot(b));

    const ordreInverse = buildOfDocumentPayload(
      buildFixtureInput({ operations: [...buildFixtureInput().operations].reverse() })
    );
    // Les phases sont triées à la construction : l'ordre d'entrée n'influe pas.
    expect(hashSnapshot(ordreInverse)).toBe(hashSnapshot(a));
  });
});

describe("#374 E — rendu serveur", () => {
  it("rend un PDF A4 et y imprime les données attendues", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput());
    const { buffer, sha256, byteSize } = await renderOfDocument(payload);

    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(byteSize).toBe(buffer.byteLength);
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);

    const text = pdfText(buffer);
    for (const expected of [
      "OF-2026-23149",
      "R00",
      "CF00042720 1",
      "AIRBUS HELICOPTERS",
      "45 252 966 B",
      // La pièce est un ORDRE DE FABRICATION. Une gamme est la définition
      // technique d'une pièce, réutilisable d'un OF à l'autre ; un OF est l'ordre
      // de lancer une quantité, pour une commande, à une date. Il EMBARQUE la
      // gamme applicable, il ne s'y réduit pas.
      "ORDRE DE FABRICATION",
      // Les titres de section sont rendus en capitales par le socle document.
      "GAMME APPLICABLE",
      "71 h",
    ]) {
      expect(text).toContain(expected);
    }

    // Garde anti-régression : le mauvais titre ne doit pas revenir. Un document
    // intitulé « gamme de fabrication » ferait passer un ordre de lancement pour
    // une fiche technique.
    expect(text).not.toContain("GAMME DE FABRICATION");
  });

  it("réimprime le même binaire et la même empreinte", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput());
    const first = await renderOfDocument(payload);
    const second = await renderOfDocument(payload);

    expect(second.sha256).toBe(first.sha256);
    expect(second.buffer.equals(first.buffer)).toBe(true);
  });

  it("change d'empreinte dès qu'une donnée imprimée change", async () => {
    const base = await renderOfDocument(buildOfDocumentPayload(buildFixtureInput()));
    const autreQuantite = await renderOfDocument(
      buildOfDocumentPayload(
        buildFixtureInput({
          quantites: {
            quantiteDemandee: 60,
            quantiteLivree: 0,
            stockReserve: 0,
            couvertAutresOf: 0,
            quantiteAffecteeCetOf: 60,
          },
        })
      )
    );
    expect(autreQuantite.sha256).not.toBe(base.sha256);
  });

  it("refuse un horodatage invalide plutôt que de dater le document du jour", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ generatedAt: "pas-une-date" }));
    await expect(renderOfDocument(payload)).rejects.toThrow(/Horodatage/);
  });

  it("imprime le filigrane du brouillon", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ watermark: "BROUILLON" }));
    const { buffer } = await renderOfDocument(payload);
    expect(pdfText(buffer)).toContain("BROUILLON");
  });

  it("pagine 100 phases et réémet l'en-tête sur chaque page", async () => {
    const operations: OfRevisionOperation[] = Array.from({ length: 100 }, (_, index) => ({
      phase: (index + 1) * 10,
      designation: `OPERATION ${index + 1}`,
      family: (["T", "F", "TTRAD", "FTRAD"] as const)[index % 4],
      machineId: null,
      machineLabel: `MACHINE-${(index % 7) + 1}`,
      programme: `PGM-${index + 1}`,
      tempsUnitaire: 0.1,
      preparation: 0.5,
      quantiteBase: FIXTURE_QUANTITE_BASE,
      coefficient: 1,
    }));

    const payload = buildOfDocumentPayload(buildFixtureInput({ operations, visas: {} }));
    expect(payload.phases).toHaveLength(100);

    const { buffer } = await renderOfDocument(payload);
    const pages = countPages(buffer);
    expect(pages).toBeGreaterThan(5);

    const text = pdfText(buffer);
    // Le pied de page numérote sur le total réel.
    expect(text).toContain(`Page 1 / ${pages}`);
    expect(text).toContain(`Page ${pages} / ${pages}`);
    // Première et dernière phase présentes : rien n'est perdu à la pagination.
    expect(text).toContain("OPERATION 1");
    expect(text).toContain("OPERATION 100");
  });

  it("supporte plusieurs commandes, affaires et cadences", async () => {
    const payload = buildOfDocumentPayload(
      buildFixtureInput({
        commandeNumero: "CF00042720 1 / CF00042955 2",
        affaires: [
          { affaireId: 23149, numero: "23 149", delaiClient: "2026-07-01", quantite: 40 },
          { affaireId: 23150, numero: "23 150", delaiClient: "2026-08-15", quantite: 25 },
          { affaireId: 23151, numero: "23 151", delaiClient: "2026-09-30", quantite: 35 },
        ],
        cadenceLivraison: [
          { date: "2026-09-30", quantite: 35, affaireNumero: "23 151" },
          { date: "2026-07-01", quantite: 40, affaireNumero: "23 149" },
          { date: "2026-08-15", quantite: 25, affaireNumero: "23 150" },
        ],
        quantites: {
          quantiteDemandee: 100,
          quantiteLivree: 10,
          stockReserve: 15,
          couvertAutresOf: 20,
          quantiteAffecteeCetOf: 40,
        },
      })
    );

    // Les échéances sont réordonnées : l'entrée désordonnée ne change pas le rendu.
    expect(payload.cadenceLivraison.map((c) => c.date)).toEqual([
      "2026-07-01",
      "2026-08-15",
      "2026-09-30",
    ]);
    expect(payload.quantites.resteNetACouvrir).toBe(15);

    const text = pdfText((await renderOfDocument(payload)).buffer);
    for (const expected of ["23 149", "23 150", "23 151", "15/08/2026", "30/09/2026"]) {
      expect(text).toContain(expected);
    }
  });

  it("rend un OF sans phase sans planter", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ operations: [], visas: {} }));
    const { buffer } = await renderOfDocument(payload);
    expect(pdfText(buffer)).toContain("Aucune phase dans cette révision.");
  });
});
