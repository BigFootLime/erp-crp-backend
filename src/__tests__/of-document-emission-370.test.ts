// Garanties documentaires du chantier #370.
//
// Ces tests portent sur ce qui rend le document OPPOSABLE : l'aperçu et l'émission
// partagent le même read-model, une réimpression reproduit le binaire à l'octet,
// et un document ne se laisse pas émettre deux fois.

import { describe, expect, it } from "vitest";

import {
  buildOfDocumentPayload,
  hashDocumentPayload,
  OF_DOCUMENT_TEMPLATE_VERSION,
  watermarkFor,
  type OfDocumentPayload,
} from "../module/production/domain/of-document";
import { renderOfDocument } from "../module/production/services/of-document-render";
import {
  buildFixtureInput,
  FIXTURE_FAMILLES,
  FIXTURE_OPERATIONS_TFT,
} from "../module/production/domain/__fixtures__/of-document.fixture";

describe("#370 — l'aperçu et l'émission partagent le même read-model", () => {
  it("produit un payload identique pour le même instantané", () => {
    // Une seule fonction construit le payload : l'aperçu et l'émission ne peuvent
    // pas divergier, puisqu'il n'y a pas deux chemins à faire concorder.
    const a = buildOfDocumentPayload(buildFixtureInput({ documentStatut: "BROUILLON" }));
    const b = buildOfDocumentPayload(buildFixtureInput({ documentStatut: "BROUILLON" }));
    expect(hashDocumentPayload(a)).toBe(hashDocumentPayload(b));
  });

  it("distingue l'empreinte du DOCUMENT de celle de la RÉVISION", () => {
    const officiel = buildOfDocumentPayload(buildFixtureInput({ documentStatut: "OFFICIEL" }));
    const brouillon = buildOfDocumentPayload(buildFixtureInput({ documentStatut: "BROUILLON" }));

    // Même révision : l'empreinte technique ne bouge pas…
    expect(officiel.snapshotSha256).toBe(brouillon.snapshotSha256);
    // …mais le document diffère (statut, filigrane), et cela doit se voir.
    expect(hashDocumentPayload(officiel)).not.toBe(hashDocumentPayload(brouillon));
  });

  it("porte la version du gabarit dans le payload figé", () => {
    const payload = buildOfDocumentPayload(buildFixtureInput());
    expect(payload.templateVersion).toBe(OF_DOCUMENT_TEMPLATE_VERSION);

    // Changer de gabarit change l'empreinte du document : deux PDF de même
    // contenu rendus par deux gabarits différents ne sont pas le même document.
    const autre = buildOfDocumentPayload(buildFixtureInput({ templateVersion: "of-gamme/9.9" }));
    expect(hashDocumentPayload(autre)).not.toBe(hashDocumentPayload(payload));
  });
});

describe("#370 — une réimpression reproduit le document émis à l'octet", () => {
  it("rend deux fois le même binaire depuis le même payload figé", async () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ documentStatut: "OFFICIEL" }));

    const first = await renderOfDocument(payload);
    const second = await renderOfDocument(payload);

    // C'est la garantie de la réimpression : le rendu ne lit AUCUNE horloge,
    // `generatedAt` vient du payload. Sans cela, chaque réimpression produirait
    // une empreinte différente et le document ne serait plus opposable.
    expect(second.sha256).toBe(first.sha256);
    expect(second.byteSize).toBe(first.byteSize);
    expect(second.buffer.equals(first.buffer)).toBe(true);
  });

  it("change d'empreinte dès qu'une donnée du document change", async () => {
    const base = buildOfDocumentPayload(buildFixtureInput({ documentStatut: "OFFICIEL" }));
    const modifie = buildOfDocumentPayload(
      buildFixtureInput({ documentStatut: "OFFICIEL", operations: FIXTURE_OPERATIONS_TFT })
    );

    const a = await renderOfDocument(base);
    const b = await renderOfDocument(modifie);
    expect(b.sha256).not.toBe(a.sha256);
  });

  it("rejoue un payload relu depuis JSON à l'identique", async () => {
    // La réimpression relit le payload depuis `of_documents.payload` (jsonb) :
    // l'aller-retour de sérialisation ne doit rien changer au binaire.
    const payload = buildOfDocumentPayload(buildFixtureInput({ documentStatut: "OFFICIEL" }));
    const relu = JSON.parse(JSON.stringify(payload)) as OfDocumentPayload;

    const direct = await renderOfDocument(payload);
    const apresJson = await renderOfDocument(relu);
    expect(apresJson.sha256).toBe(direct.sha256);
  });
});

describe("#370 — le filigrane protège de la confusion documentaire", () => {
  it("marque BROUILLON, OBSOLETE, et rien sur un officiel courant", () => {
    expect(watermarkFor({ revisionStatut: "ACTIVE", documentStatut: "BROUILLON" })).toBe("BROUILLON");
    expect(watermarkFor({ revisionStatut: "ACTIVE", documentStatut: "OBSOLETE" })).toBe("OBSOLETE");
    // Un document officiel d'une révision périmée est OBSOLETE : c'est le cas le
    // plus dangereux, il ressemble sinon exactement à l'exemplaire courant.
    expect(watermarkFor({ revisionStatut: "OBSOLETE", documentStatut: "OFFICIEL" })).toBe("OBSOLETE");
    expect(watermarkFor({ revisionStatut: "ACTIVE", documentStatut: "OFFICIEL" })).toBeNull();
  });

  it("produit un binaire différent avec et sans filigrane", async () => {
    const sans = await renderOfDocument(buildOfDocumentPayload(buildFixtureInput({ watermark: null })));
    const avec = await renderOfDocument(
      buildOfDocumentPayload(buildFixtureInput({ watermark: "BROUILLON" }))
    );
    // Le filigrane est réellement dessiné, pas seulement stocké dans le payload.
    expect(avec.sha256).not.toBe(sans.sha256);
    expect(avec.byteSize).toBeGreaterThan(sans.byteSize);
  });
});

describe("#370 — une donnée absente est signalée, jamais remplacée", () => {
  it("signale un n° de programme manquant sur une famille qui l'exige", () => {
    const payload = buildOfDocumentPayload(
      buildFixtureInput({
        operations: [
          {
            phase: 10,
            designation: "FRAISAGE CN",
            family: "F",
            machineId: null,
            machineLabel: "VMC-1",
            programme: null,
            tempsUnitaire: 0.1,
            preparation: 0,
            quantiteBase: 10,
            coefficient: 1,
            cfCode: "FCN",
            cfRateId: null,
            tauxHoraire: 68,
            tauxHoraireSource: "CENTRE_FRAIS",
            tauxHoraireEffectiveAt: "2026-01-01",
          },
        ],
        visas: {},
      })
    );

    expect(payload.phases[0].programmeManquant).toBe(true);
    expect(payload.phases[0].programme).toBeNull();
    expect(payload.avertissements.map((a) => a.code)).toContain("PROGRAMME_MANQUANT");
  });

  it("ne signale RIEN sur une famille qui n'exige pas de programme", () => {
    const payload = buildOfDocumentPayload(
      buildFixtureInput({
        operations: [
          {
            phase: 20,
            designation: "DEBIT",
            family: "DECOUPE",
            machineId: null,
            machineLabel: "Scie",
            programme: null,
            tempsUnitaire: 0.05,
            preparation: 0,
            quantiteBase: 10,
            coefficient: 1,
            cfCode: "DEB",
            cfRateId: null,
            tauxHoraire: 42,
            tauxHoraireSource: "CENTRE_FRAIS",
            tauxHoraireEffectiveAt: "2026-01-01",
          },
        ],
        visas: {},
      })
    );

    // `programme_requis` est faux pour DECOUPE : son absence n'est pas un défaut
    // et ne doit pas noyer les vrais signalements.
    expect(payload.phases[0].programmeManquant).toBe(false);
    expect(payload.avertissements.map((a) => a.code)).not.toContain("PROGRAMME_MANQUANT");
  });

  it("ne déduit AUCUNE longueur totale quand un terme manque", () => {
    const payload = buildOfDocumentPayload(
      buildFixtureInput({
        decoupe: {
          dimensions: null,
          longueurBrutMm: 57,
          longueurUtileMm: null,
          traitDeScieMm: null,
          chuteMm: null,
          nombreBruts: null, // terme manquant
          piecesParBrut: 1,
          masseTotaleKg: null,
          unite: null,
          methodeCalcul: null,
        },
      })
    );

    expect(payload.decoupe.longueurTotaleMm).toBeNull();
    expect(payload.decoupe.methodeCalcul).toBeNull();
    expect(payload.avertissements.map((a) => a.code)).toContain("DECOUPE_INCOMPLETE");
  });

  it("publie la méthode de calcul quand la longueur EST calculable", () => {
    const payload = buildOfDocumentPayload(buildFixtureInput());
    expect(payload.decoupe.longueurTotaleMm).toBe(2280);
    expect(payload.decoupe.methodeCalcul).toContain("longueur de brut");
    expect(payload.decoupe.methodeCalcul).toContain("nombre de bruts");
  });

  it("signale une famille absente du référentiel sans l'inventer", () => {
    const payload = buildOfDocumentPayload(
      buildFixtureInput({
        operations: [
          {
            phase: 10,
            designation: "PHASE EXOTIQUE",
            family: "RECTIF",
            machineId: null,
            machineLabel: null,
            programme: null,
            tempsUnitaire: 0.1,
            preparation: 0,
            quantiteBase: 10,
            coefficient: 1,
            cfCode: null,
            cfRateId: null,
            tauxHoraire: null,
            tauxHoraireSource: null,
            tauxHoraireEffectiveAt: null,
          },
        ],
        visas: {},
        familles: FIXTURE_FAMILLES,
      })
    );

    expect(payload.avertissements.map((a) => a.code)).toContain("FAMILLE_INCONNUE");
    // Le code est conservé tel quel : on ne le remplace pas par une famille
    // « proche », qui enverrait la pièce sur la mauvaise machine.
    expect(payload.phases[0].family).toBe("RECTIF");
    expect(payload.phases[0].familyLabel).toBe("RECTIF");
  });

  it("signale l'absence de référentiel plutôt que de taire le non-contrôle", () => {
    const payload = buildOfDocumentPayload(buildFixtureInput({ familles: undefined }));
    expect(payload.avertissements.map((a) => a.code)).toContain("REFERENTIEL_FAMILLES_ABSENT");
  });

  it("trie les avertissements de façon stable — ils entrent dans le hash", () => {
    const a = buildOfDocumentPayload(buildFixtureInput({ familles: undefined }));
    const b = buildOfDocumentPayload(buildFixtureInput({ familles: undefined }));
    expect(a.avertissements).toEqual(b.avertissements);
    expect(hashDocumentPayload(a)).toBe(hashDocumentPayload(b));
  });
});

describe("#370 — le VISA est imprimé même vide et reste solidaire de sa phase", () => {
  it("donne un bloc VISA à CHAQUE phase, visée ou non", () => {
    const payload = buildOfDocumentPayload(buildFixtureInput());
    // Une zone imprimée seulement si déjà remplie serait inutilisable au poste :
    // c'est la case que l'atelier remplit au stylo.
    expect(payload.phases).toHaveLength(11);
    for (const phase of payload.phases) {
      expect(phase.visa).toBeDefined();
      expect(phase.visa.statut).toBeTruthy();
    }
    const nonVisee = payload.phases.find((p) => p.phase === 20);
    expect(nonVisee?.visa.statut).toBe("A_FAIRE");
    expect(nonVisee?.visa.visaOperateur).toBeNull();
  });

  it("sépare le visa opérateur du visa contrôle", () => {
    const payload = buildOfDocumentPayload(buildFixtureInput());
    const controlee = payload.phases.find((p) => p.phase === 110);
    expect(controlee?.visa.visaOperateur).toBe("TB");
    expect(controlee?.visa.visaControle).toBe("MC");
    expect(controlee?.visa.visaControle).not.toBe(controlee?.visa.visaOperateur);
  });

  it("conserve quantités et motif de rebut par phase", () => {
    const payload = buildOfDocumentPayload(buildFixtureInput());
    const rebut = payload.phases.find((p) => p.phase === 60);
    expect(rebut?.visa.quantiteBonne).toBe(39);
    expect(rebut?.visa.quantiteRebut).toBe(1);
    expect(rebut?.visa.motifRebut).toBe("Cote hors tolérance");
  });
});

describe("#370 — pagination et volumétrie", () => {
  it("rend 1 phase et 100 phases sans échouer", async () => {
    const une = buildOfDocumentPayload(
      buildFixtureInput({ operations: [FIXTURE_OPERATIONS_TFT[0]], visas: {} })
    );
    expect(une.phases).toHaveLength(1);
    const renduUne = await renderOfDocument(une);
    expect(renduUne.byteSize).toBeGreaterThan(0);

    const cent = buildOfDocumentPayload(
      buildFixtureInput({
        operations: Array.from({ length: 100 }, (_, i) => ({
          ...FIXTURE_OPERATIONS_TFT[i % 3],
          phase: (i + 1) * 10,
        })),
        visas: {},
      })
    );
    expect(cent.phases).toHaveLength(100);
    const renduCent = await renderOfDocument(cent);
    // Un document de 100 phases est nettement plus lourd : la preuve qu'aucune
    // phase n'a été silencieusement tronquée.
    expect(renduCent.byteSize).toBeGreaterThan(renduUne.byteSize);
  });
});
