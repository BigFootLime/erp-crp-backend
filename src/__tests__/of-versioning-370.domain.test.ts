// Chantier #374 — versioning d'OF, dérive de temps, brouillon de planning, AR à recaler.
//
// Ces tests portent sur les règles, pas sur le transport : ils échouent si la
// règle métier change, pas si un contrôleur bouge.

import { describe, expect, it } from "vitest";

import {
  buildRevisionSnapshot,
  canonicalJson,
  checkRevisionCreation,
  diffRevisionSnapshots,
  formatRevisionCode,
  hashSnapshot,
  nextRevisionRank,
  parseRevisionCode,
  phaseFabricationTime,
  phaseFinalTime,
  snapshotTotalTime,
  type OfRevisionOperation,
} from "../module/production/domain/of-revision";
import {
  assessTimeVariance,
  buildTimeVarianceProposal,
  formatPct,
  OF_TIME_VARIANCE_THRESHOLD_PCT,
  roundPct,
} from "../module/production/domain/of-time-variance";
import {
  buildPlanningPayload,
  canTransitionPlanningStatut,
  checkPlanningTransition,
  comparePlanningVersions,
  diffDays,
  hashPlanningPayload,
  requiresArRecalage,
  type OfPlanningPayload,
} from "../module/production/domain/of-planning-version";
import {
  buildArRecalageDossiers,
  canTransitionArStatut,
  decideArRecalage,
  validateArRecalageInput,
} from "../module/production/domain/ar-recalage";
import {
  notificationDedupeKey,
  NOTIFICATION_TOPICS,
  resolveNotificationRecipients,
} from "../../src/shared/notifications/routing";
import { roleHasOfCapability } from "../module/production/domain/of-rbac";
import { authorizationRole } from "../module/auth/domain/roles";
import {
  FIXTURE_EXPECTED_TF,
  FIXTURE_EXPECTED_TOTAL,
  FIXTURE_EXPECTED_TOTAL_TF,
  FIXTURE_EXPECTED_TOTAL_TP,
  FIXTURE_OPERATIONS,
} from "../module/production/domain/__fixtures__/of-document.fixture";

const baseOperation = (over: Partial<OfRevisionOperation> = {}): OfRevisionOperation => ({
  phase: 10,
  designation: "FRAISAGE CN",
  family: "F",
  machineId: "m-1",
  machineLabel: "VMC-1",
  programme: "PGM-1",
  tempsUnitaire: 0.1,
  preparation: 0.5,
  quantiteBase: 40,
  coefficient: 1,
  ...over,
});

const snapshotOf = (operations: OfRevisionOperation[]) =>
  buildRevisionSnapshot({
    ofId: 1,
    ofNumero: "OF-2026-23149",
    pieceReference: "45 252 966 B",
    pieceDesignation: "BOITIER T16E M2",
    pieceIndice: "B",
    gammeId: "g-1",
    gammeCode: "GAMME-1",
    gammeVersion: "1",
    quantiteLancee: 40,
    matiere: {
      reference: "PL*6061*T651*1*25*12",
      designation: "ALUMINIUM 6061/T651",
      nuance: "6061/T651",
      longueurBrutMm: 57,
      nombreBruts: 40,
      piecesParBrut: 1,
      masseTotaleKg: 0.91,
    },
    operations,
  });

// ---------------------------------------------------------------------------
// Partie A — versioning
// ---------------------------------------------------------------------------

describe("#374 A — versioning d'OF", () => {
  it("formate et relit les codes de révision", () => {
    expect(formatRevisionCode(0)).toBe("R00");
    expect(formatRevisionCode(1)).toBe("R01");
    expect(formatRevisionCode(12)).toBe("R12");
    expect(formatRevisionCode(100)).toBe("R100");
    expect(parseRevisionCode("R00")).toBe(0);
    expect(parseRevisionCode("R07")).toBe(7);
    expect(parseRevisionCode("R100")).toBe(100);
    expect(parseRevisionCode("REV1")).toBeNull();
    expect(() => formatRevisionCode(-1)).toThrow();
  });

  it("enchaîne les rangs depuis la création", () => {
    expect(nextRevisionRank(null)).toBe(0);
    expect(nextRevisionRank(0)).toBe(1);
    expect(nextRevisionRank(41)).toBe(42);
  });

  it("hache la même définition à l'identique quel que soit l'ordre des clés", () => {
    const a = { z: 1, a: { y: 2, b: [3, { d: 4, c: 5 }] } };
    const b = { a: { b: [3, { c: 5, d: 4 }], y: 2 }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashSnapshot(a)).toBe(hashSnapshot(b));
  });

  it("ignore -0 et les clés indéfinies dans l'empreinte", () => {
    expect(hashSnapshot({ v: -0 })).toBe(hashSnapshot({ v: 0 }));
    expect(hashSnapshot({ v: 1, absent: undefined })).toBe(hashSnapshot({ v: 1 }));
  });

  it("distingue deux définitions qui diffèrent d'un seul temps", () => {
    const before = snapshotOf([baseOperation()]);
    const after = snapshotOf([baseOperation({ tempsUnitaire: 0.11 })]);
    expect(hashSnapshot(before)).not.toBe(hashSnapshot(after));
  });

  it("décrit l'écart phase par phase entre deux révisions", () => {
    const before = snapshotOf([
      baseOperation({ phase: 10 }),
      baseOperation({ phase: 20, machineLabel: "VMC-2" }),
    ]);
    const after = snapshotOf([
      baseOperation({ phase: 10, tempsUnitaire: 0.2 }),
      baseOperation({ phase: 30, machineLabel: "VMC-3" }),
    ]);

    const diff = diffRevisionSnapshots(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.summary).toMatchObject({
      phasesAjoutees: 1,
      phasesRetirees: 1,
      phasesModifiees: 1,
    });
    const modified = diff.phases.find((p) => p.phase === 10);
    expect(modified?.changes.map((c) => c.field)).toContain("tempsUnitaire");
    expect(diff.phases.find((p) => p.phase === 30)?.kind).toBe("AJOUTEE");
    expect(diff.phases.find((p) => p.phase === 20)?.kind).toBe("RETIREE");
  });

  it("signale un changement de matière et de quantité en entête", () => {
    const before = snapshotOf([baseOperation()]);
    const after = buildRevisionSnapshot({
      ...before,
      quantiteLancee: 60,
      matiere: { ...before.matiere!, nombreBruts: 60 },
    });
    const diff = diffRevisionSnapshots(before, after);
    expect(diff.header.map((c) => c.field)).toContain("quantiteLancee");
    expect(diff.matiere.map((c) => c.field)).toContain("nombreBruts");
  });

  it("traite la première révision comme un ajout intégral", () => {
    const diff = diffRevisionSnapshots(null, snapshotOf([baseOperation(), baseOperation({ phase: 20 })]));
    expect(diff.summary.phasesAjoutees).toBe(2);
    expect(diff.summary.phasesRetirees).toBe(0);
  });

  it("exige un motif dès R01 et refuse une révision identique", () => {
    const snapshot = snapshotOf([baseOperation()]);
    const identical = diffRevisionSnapshots(snapshot, snapshot);
    const changed = diffRevisionSnapshots(snapshot, snapshotOf([baseOperation({ tempsUnitaire: 0.3 })]));

    expect(checkRevisionCreation({ nextRank: 0, motif: null, diff: changed })).toEqual({ allowed: true });
    expect(checkRevisionCreation({ nextRank: 1, motif: "  ", diff: changed })).toMatchObject({
      allowed: false,
      code: "MOTIF_REQUIS",
    });
    expect(checkRevisionCreation({ nextRank: 1, motif: "Nouvelle prise de pièce", diff: changed })).toEqual({
      allowed: true,
    });
    expect(checkRevisionCreation({ nextRank: 1, motif: "Motif", diff: identical })).toMatchObject({
      allowed: false,
      code: "REVISION_IDENTIQUE",
    });
  });

  it("applique fabrication = t_unit x quantité x coefficient, final = prépa + fabrication", () => {
    const operation = baseOperation({ tempsUnitaire: 0.25, quantiteBase: 40, coefficient: 1, preparation: 1 });
    expect(phaseFabricationTime(operation)).toBeCloseTo(10, 10);
    expect(phaseFinalTime(operation)).toBeCloseTo(11, 10);

    const withCoef = baseOperation({ tempsUnitaire: 0.1, quantiteBase: 40, coefficient: 1.5, preparation: 0 });
    expect(phaseFabricationTime(withCoef)).toBeCloseTo(6, 10);
  });

  it("redonne les temps du document papier de l'affaire 23 149", () => {
    for (const operation of FIXTURE_OPERATIONS) {
      expect(phaseFabricationTime(operation)).toBeCloseTo(FIXTURE_EXPECTED_TF[operation.phase], 6);
    }
    const totalTp = FIXTURE_OPERATIONS.reduce((sum, o) => sum + o.preparation, 0);
    const totalTf = FIXTURE_OPERATIONS.reduce((sum, o) => sum + phaseFabricationTime(o), 0);
    expect(totalTp).toBeCloseTo(FIXTURE_EXPECTED_TOTAL_TP, 6);
    expect(totalTf).toBeCloseTo(FIXTURE_EXPECTED_TOTAL_TF, 6);
    expect(snapshotTotalTime(snapshotOf(FIXTURE_OPERATIONS))).toBeCloseTo(FIXTURE_EXPECTED_TOTAL, 6);
  });
});

// ---------------------------------------------------------------------------
// Partie B — seuil de dérive
// ---------------------------------------------------------------------------

describe("#374 B — dérive du temps d'usinage", () => {
  it("arrondit au centième en corrigeant la représentation binaire", () => {
    // (110 - 100) / 100 * 100 vaut 10.000000000000002 en IEEE 754.
    expect(roundPct(((110 - 100) / 100) * 100)).toBe(10);
    expect(roundPct(10.009999999999998)).toBe(10.01);
    expect(roundPct(-10.005)).toBe(-10.01);
    expect(roundPct(9.994)).toBe(9.99);
  });

  it("respecte le seuil strict : 9,99 rien, 10,00 rien, 10,01 replanification", () => {
    expect(assessTimeVariance({ referenceTime: 100, newTime: 109.99 })).toMatchObject({
      variationPct: 9.99,
      outcome: "RIEN",
    });
    expect(assessTimeVariance({ referenceTime: 100, newTime: 110 })).toMatchObject({
      variationPct: 10,
      outcome: "RIEN",
    });
    expect(assessTimeVariance({ referenceTime: 100, newTime: 110.01 })).toMatchObject({
      variationPct: 10.01,
      outcome: "REPLANIFICATION",
    });
    expect(OF_TIME_VARIANCE_THRESHOLD_PCT).toBe(10);
  });

  it("tient le seuil sur des temps réels en heures, pas seulement sur des centaines", () => {
    // 4 h de référence : 4,40 h est pile à 10 %, 4,4005 h passe au-dessus.
    expect(assessTimeVariance({ referenceTime: 4, newTime: 4.4 }).outcome).toBe("RIEN");
    expect(assessTimeVariance({ referenceTime: 4, newTime: 4.4005 }).outcome).toBe("REPLANIFICATION");
    expect(assessTimeVariance({ referenceTime: 0.035, newTime: 0.05 }).outcome).toBe("REPLANIFICATION");
  });

  it("impose une revue quand la référence est absente ou nulle", () => {
    for (const reference of [null, undefined, 0]) {
      const assessment = assessTimeVariance({ referenceTime: reference, newTime: 5 });
      expect(assessment.outcome).toBe("REVUE");
      expect(assessment.reviewRequired).toBe(true);
      expect(assessment.variationPct).toBeNull();
    }
  });

  it("ne propose rien sur une baisse de temps", () => {
    const assessment = assessTimeVariance({ referenceTime: 10, newTime: 5 });
    expect(assessment.variationPct).toBe(-50);
    expect(assessment.outcome).toBe("RIEN");
  });

  it("ne crée pas de proposition sous le seuil, en crée une au-dessus", () => {
    const common = {
      ofId: 1,
      ofNumero: "OF-2026-23149",
      revisionId: "rev-1",
      revisionCode: "R00",
      ofOperationId: "op-1",
      phase: 30,
      family: "F" as const,
      cause: "DERIVE_TEMPS_USINAGE" as const,
      causeComment: null,
      authorUserId: 7,
      impactCharge: { chargeAvantH: 59, chargeApresH: 65, deltaH: 6, operationsImpactees: 1 },
      machines: [],
      affaires: [],
      simulation: {
        schema: "of-time-variance-simulation/1" as const,
        decalageFinJours: 2,
        dateFinAvant: "2026-06-20",
        dateFinApres: "2026-06-22",
        engagementsEnRisque: [],
      },
    };

    expect(buildTimeVarianceProposal({ ...common, referenceTime: 4, newTime: 4.4 }).created).toBe(false);

    const created = buildTimeVarianceProposal({ ...common, referenceTime: 4, newTime: 5 });
    expect(created.created).toBe(true);
    if (created.created) {
      expect(created.proposal.variationPct).toBe(25);
      expect(created.proposal.outcome).toBe("REPLANIFICATION");
      // Le contexte d'impact est figé avec la proposition.
      expect(created.proposal.impactCharge.deltaH).toBe(6);
      expect(created.proposal.simulation.decalageFinJours).toBe(2);
    }

    expect(() =>
      buildTimeVarianceProposal({ ...common, cause: "AUTRE", referenceTime: 4, newTime: 5 })
    ).toThrow(/Autre/);
  });

  it("formate le pourcentage à la française", () => {
    expect(formatPct(10.01)).toBe("10,01 %");
    expect(formatPct(10)).toBe("10,00 %");
  });
});

// ---------------------------------------------------------------------------
// Partie C — brouillon de planning
// ---------------------------------------------------------------------------

const planningPayload = (over: Partial<Omit<OfPlanningPayload, "schema">> = {}): OfPlanningPayload =>
  buildPlanningPayload({
    ofId: 1,
    ofNumero: "OF-2026-23149",
    revisionCode: "R00",
    quantite: 40,
    dateDebut: "2026-06-01",
    dateFin: "2026-06-20",
    chargeTotaleH: 71,
    operations: [
      {
        phase: 30,
        designation: "FRAISAGE CN",
        family: "F",
        machineId: "m-1",
        machineLabel: "VMC-1",
        debut: "2026-06-01",
        fin: "2026-06-02",
        dureeH: 4.5,
        quantite: 40,
      },
    ],
    cadence: [{ date: "2026-07-01", quantite: 40, affaireId: 23149 }],
    engagements: [
      {
        affaireId: 23149,
        affaireNumero: "23 149",
        commandeId: 900,
        commandeNumero: "CF00042720 1",
        clientId: "003",
        delaiClient: "2026-07-01",
        quantite: 40,
      },
    ],
    ...over,
  });

describe("#374 C — brouillon de planning versionné", () => {
  it("n'autorise que le cycle ACTIF -> BROUILLON -> SOUMIS -> VALIDE/REFUSE -> ACTIF", () => {
    expect(canTransitionPlanningStatut("BROUILLON", "SOUMIS")).toBe(true);
    expect(canTransitionPlanningStatut("SOUMIS", "VALIDE")).toBe(true);
    expect(canTransitionPlanningStatut("SOUMIS", "REFUSE")).toBe(true);
    expect(canTransitionPlanningStatut("VALIDE", "ACTIF")).toBe(true);
    expect(canTransitionPlanningStatut("ACTIF", "SUPERSEDE")).toBe(true);

    // Un brouillon ne devient jamais actif sans passer par la validation.
    expect(canTransitionPlanningStatut("BROUILLON", "ACTIF")).toBe(false);
    expect(canTransitionPlanningStatut("BROUILLON", "VALIDE")).toBe(false);
    // Un refus est terminal.
    expect(canTransitionPlanningStatut("REFUSE", "BROUILLON")).toBe(false);
    expect(checkPlanningTransition("REFUSE", "ACTIF")).toMatchObject({
      allowed: false,
      code: "TRANSITION_INTERDITE",
    });
  });

  it("hache le plan et détecte l'absence de changement", () => {
    const a = planningPayload();
    const b = planningPayload();
    expect(hashPlanningPayload(a)).toBe(hashPlanningPayload(b));
    expect(comparePlanningVersions(a, b).identical).toBe(true);
  });

  it("compare opérations, dates, machines, durées, charge et quantité", () => {
    const before = planningPayload();
    const after = planningPayload({
      quantite: 45,
      chargeTotaleH: 80,
      dateFin: "2026-06-25",
      operations: [
        {
          phase: 30,
          designation: "FRAISAGE CN",
          family: "F",
          machineId: "m-2",
          machineLabel: "VMC-2",
          debut: "2026-06-01",
          fin: "2026-06-03",
          dureeH: 6,
          quantite: 45,
        },
        {
          phase: 40,
          designation: "EBAVURAGE",
          family: null,
          machineId: null,
          machineLabel: null,
          debut: "2026-06-04",
          fin: "2026-06-04",
          dureeH: 1,
          quantite: 45,
        },
      ],
    });

    const comparison = comparePlanningVersions(before, after);
    expect(comparison.header.map((c) => c.field)).toEqual(
      expect.arrayContaining(["quantite", "dateFin", "chargeTotaleH"])
    );
    expect(comparison.summary.operationsAjoutees).toBe(1);
    expect(comparison.summary.machinesChangees).toBe(1);
    expect(comparison.summary.deltaChargeH).toBe(9);
    expect(comparison.summary.deltaFinJours).toBe(5);
  });

  it("ne voit aucun impact client quand le délai et la cadence tiennent", () => {
    const before = planningPayload();
    // L'OF glisse en interne mais livre toujours le 01/07.
    const after = planningPayload({ dateFin: "2026-06-25", chargeTotaleH: 75 });

    const comparison = comparePlanningVersions(before, after);
    expect(comparison.clientImpact).toBe("AUCUN");
    expect(comparison.summary.engagementsDepasses).toBe(0);
    expect(requiresArRecalage(comparison)).toBe(false);
  });

  it("détecte le dépassement d'un engagement client", () => {
    const before = planningPayload();
    const after = planningPayload({
      dateFin: "2026-07-20",
      cadence: [{ date: "2026-07-20", quantite: 40, affaireId: 23149 }],
    });

    const comparison = comparePlanningVersions(before, after);
    expect(comparison.engagements[0]).toMatchObject({
      depasse: true,
      retardJours: 19,
      delaiClient: "2026-07-01",
      nouvelleDate: "2026-07-20",
    });
    expect(comparison.clientImpact).toBe("DELAI_ET_CADENCE");
    expect(requiresArRecalage(comparison)).toBe(true);
  });

  it("distingue deux affaires livrant le même jour", () => {
    const before = planningPayload({
      cadence: [
        { date: "2026-07-01", quantite: 40, affaireId: 23149 },
        { date: "2026-07-01", quantite: 25, affaireId: 23150 },
      ],
    });
    const after = planningPayload({
      cadence: [
        { date: "2026-07-01", quantite: 40, affaireId: 23149 },
        { date: "2026-07-01", quantite: 30, affaireId: 23150 },
      ],
    });

    const comparison = comparePlanningVersions(before, after);
    expect(comparison.cadence).toHaveLength(1);
    expect(comparison.cadence[0]).toMatchObject({
      affaireId: 23150,
      quantiteAvant: 25,
      quantiteApres: 30,
    });
  });

  it("compte les jours d'écart entre deux dates", () => {
    expect(diffDays("2026-07-01", "2026-07-20")).toBe(19);
    expect(diffDays("2026-07-20", "2026-07-01")).toBe(-19);
    expect(diffDays(null, "2026-07-01")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Partie D — AR à recaler
// ---------------------------------------------------------------------------

describe("#374 D — dossier d'AR client à recaler", () => {
  it("publie sans AR quand rien ne touche le client", () => {
    const comparison = comparePlanningVersions(planningPayload(), planningPayload({ chargeTotaleH: 75 }));
    const decision = decideArRecalage(comparison);
    expect(decision.required).toBe(false);
    expect(
      buildArRecalageDossiers({
        comparison,
        ofId: 1,
        ofNumero: "OF-2026-23149",
        planningVersionId: null,
        motif: "CAPACITE",
        commentaire: null,
        ownerUserId: null,
      })
    ).toEqual([]);
  });

  it("ouvre un dossier par affaire touchée, sans rien envoyer", () => {
    const comparison = comparePlanningVersions(
      planningPayload(),
      planningPayload({
        dateFin: "2026-07-20",
        cadence: [{ date: "2026-07-20", quantite: 40, affaireId: 23149 }],
      })
    );

    const dossiers = buildArRecalageDossiers({
      comparison,
      ofId: 1,
      ofNumero: "OF-2026-23149",
      planningVersionId: "plan-2",
      motif: "DERIVE_TEMPS_USINAGE",
      commentaire: null,
      ownerUserId: 12,
      clientNomByClientId: { "003": "AIRBUS HELICOPTERS" },
      commandeNumeroById: { 900: "CF00042720 1" },
      quantiteByAffaire: { 23149: 40 },
    });

    expect(dossiers).toHaveLength(1);
    expect(dossiers[0]).toMatchObject({
      clientId: "003",
      clientNom: "AIRBUS HELICOPTERS",
      commandeNumero: "CF00042720 1",
      affaireId: 23149,
      ofNumero: "OF-2026-23149",
      previousDate: "2026-07-01",
      newDate: "2026-07-20",
      quantite: 40,
      motif: "DERIVE_TEMPS_USINAGE",
      statut: "A_TRAITER",
      ownerUserId: 12,
    });

    // Le dossier ne porte aucun destinataire, aucun corps de message, aucun envoi :
    // sa forme même interdit de le confondre avec un AR sortant.
    expect(Object.keys(dossiers[0])).not.toEqual(
      expect.arrayContaining(["recipientEmails", "sentAt", "bodyText", "subject"])
    );
  });

  it("impose un commentaire au motif « Autre »", () => {
    expect(validateArRecalageInput({ motif: "AUTRE", commentaire: "  " })).toMatchObject({
      valid: false,
      code: "COMMENTAIRE_REQUIS",
    });
    expect(validateArRecalageInput({ motif: "AUTRE", commentaire: "Report demandé par le client" })).toEqual({
      valid: true,
    });
    expect(validateArRecalageInput({ motif: "MACHINE", commentaire: null })).toEqual({ valid: true });
    expect(validateArRecalageInput({ motif: "INCONNU", commentaire: null })).toMatchObject({
      valid: false,
      code: "MOTIF_INVALIDE",
    });
  });

  it("accepte les neuf motifs prédéfinis", () => {
    for (const motif of [
      "DERIVE_TEMPS_USINAGE", "MACHINE", "MATIERE", "QUALITE_REPRISE", "SOUS_TRAITANCE",
      "MODIFICATION_TECHNIQUE", "CAPACITE", "PRIORITE",
    ]) {
      expect(validateArRecalageInput({ motif, commentaire: null })).toEqual({ valid: true });
    }
  });

  it("ferme le cycle du dossier sans réouverture après clôture", () => {
    expect(canTransitionArStatut("A_TRAITER", "EN_COURS")).toBe(true);
    expect(canTransitionArStatut("EN_COURS", "RECALE")).toBe(true);
    expect(canTransitionArStatut("RECALE", "EN_COURS")).toBe(false);
    expect(canTransitionArStatut("ABANDONNE", "A_TRAITER")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routage de notification et RBAC
// ---------------------------------------------------------------------------

describe("#374 — routage de notification", () => {
  const rules = [
    { topic: NOTIFICATION_TOPICS.OF_TIME_VARIANCE, roleKey: "Planning", userId: null, isActive: true },
    { topic: NOTIFICATION_TOPICS.OF_TIME_VARIANCE, roleKey: "Planification", userId: null, isActive: true },
    { topic: NOTIFICATION_TOPICS.AR_RECALAGE, roleKey: "Commerce", userId: null, isActive: true },
    { topic: NOTIFICATION_TOPICS.AR_RECALAGE, roleKey: "Assistante polyvalente", userId: null, isActive: false },
  ];

  const candidates = [
    { userId: 1, roles: ["Planification"] },
    { userId: 2, roles: ["Commerce", "Secretaire"] },
    { userId: 3, roles: ["Opérateur atelier"] },
    { userId: 4, roles: ["Assistante polyvalente"] },
  ];

  it("route la dérive de temps vers les porteurs du rôle planificateur", () => {
    expect(
      resolveNotificationRecipients({
        topic: NOTIFICATION_TOPICS.OF_TIME_VARIANCE,
        rules,
        candidates,
      })
    ).toEqual([1]);
  });

  it("route l'AR à recaler par le rôle, sans nommer personne dans le code", () => {
    expect(
      resolveNotificationRecipients({ topic: NOTIFICATION_TOPICS.AR_RECALAGE, rules, candidates })
    ).toEqual([2]);

    // Une règle désactivée ne route plus : c'est de la configuration, pas du code.
    expect(
      resolveNotificationRecipients({
        topic: NOTIFICATION_TOPICS.AR_RECALAGE,
        rules: rules.map((r) => (r.roleKey === "Assistante polyvalente" ? { ...r, isActive: true } : r)),
        candidates,
      })
    ).toEqual([2, 4]);
  });

  it("accepte une identité désignée et la dédoublonne avec son rôle", () => {
    const withIdentity = [
      ...rules,
      { topic: NOTIFICATION_TOPICS.AR_RECALAGE, roleKey: null, userId: 2, isActive: true },
      { topic: NOTIFICATION_TOPICS.AR_RECALAGE, roleKey: null, userId: 9, isActive: true },
    ];
    expect(
      resolveNotificationRecipients({
        topic: NOTIFICATION_TOPICS.AR_RECALAGE,
        rules: withIdentity,
        candidates,
      })
    ).toEqual([2, 9]);
  });

  it("compare les rôles sans se laisser arrêter par un accent ou une casse", () => {
    expect(
      resolveNotificationRecipients({
        topic: "X",
        rules: [{ topic: "X", roleKey: "Responsable Qualité", userId: null, isActive: true }],
        candidates: [{ userId: 5, roles: ["responsable qualite"] }],
      })
    ).toEqual([5]);
  });

  it("ne route vers personne quand aucune règle n'existe", () => {
    expect(resolveNotificationRecipients({ topic: "INCONNU", rules, candidates })).toEqual([]);
  });

  it("produit une clé de déduplication stable", () => {
    const key = notificationDedupeKey(NOTIFICATION_TOPICS.AR_RECALAGE, 1, "rev-1", null);
    expect(key).toBe("AR_RECALAGE:1:rev-1:");
    expect(notificationDedupeKey(NOTIFICATION_TOPICS.AR_RECALAGE, 1, "rev-1", null)).toBe(key);
  });
});

describe("#374 — RBAC", () => {
  it("réserve la révision aux méthodes et à la programmation", () => {
    expect(roleHasOfCapability("Responsable Programmation", "revise")).toBe(true);
    expect(roleHasOfCapability("Études-Méthodes", "revise")).toBe(true);
    expect(roleHasOfCapability("Opérateur atelier", "revise")).toBe(false);
  });

  it("laisse l'atelier viser mais pas valider un planning", () => {
    expect(roleHasOfCapability("Opérateur atelier", "visa")).toBe(true);
    expect(roleHasOfCapability("Opérateur atelier", "plan_validate")).toBe(false);
    expect(roleHasOfCapability("Planification", "plan_validate")).toBe(true);
  });

  it("réserve le recalage d'AR au commerce et à l'assistance", () => {
    expect(roleHasOfCapability("Commercial", "ar_recalage")).toBe(true);
    // « Assistante polyvalente » ARRIVE ICI sous son alias « Secretaire ».
    expect(roleHasOfCapability("Secretaire", "ar_recalage")).toBe(true);
    expect(roleHasOfCapability("Opérateur atelier", "ar_recalage")).toBe(false);
    // « Fraisage » s'alias en « Opérateur atelier » : refusé, comme attendu.
    expect(roleHasOfCapability("Opérateur atelier", "ar_recalage")).toBe(false);
  });

  /**
   * L'entrée de `roleHasOfCapability` est le rôle EFFECTIF, pas l'intitulé
   * d'organigramme.
   *
   * Ces deux tests visaient juste, mais avec le mauvais vocabulaire : ils
   * passaient « Planning » et « Assistante polyvalente », que cette fonction ne
   * reçoit JAMAIS en production. `authorizationRole()` les traduit d'abord en
   * « Planification » et « Secretaire ». Ils ne réussissaient que grâce à deux
   * needles — « plann » et « assistant » — qui ne correspondaient à aucun alias
   * réel : une couverture illusoire, verte sur une entrée impossible.
   *
   * Les needles mortes sont retirées, et ce test fixe le contrat réel.
   */
  it("reçoit des rôles EFFECTIFS, jamais des intitulés d'organigramme", () => {
    // Ce que produit réellement la connexion pour un compte multi-rôles.
    const effectifPlanning = authorizationRole("Employee", ["Planning"]);
    expect(effectifPlanning).toContain("Planification");
    expect(roleHasOfCapability(effectifPlanning, "plan_validate")).toBe(true);

    const effectifAssistante = authorizationRole("Employee", ["Assistante polyvalente"]);
    expect(effectifAssistante).toContain("Secretaire");
    expect(roleHasOfCapability(effectifAssistante, "ar_recalage")).toBe(true);

    // Un compte cumulant atelier et planification hérite des deux capacités :
    // la chaîne d'alias est jointe par « | » et testée d'un bloc.
    const effectifCumul = authorizationRole("Employee", ["Responsable Atelier-Production", "Planning"]);
    expect(roleHasOfCapability(effectifCumul, "visa")).toBe(true);
    expect(roleHasOfCapability(effectifCumul, "plan_validate")).toBe(true);

    // Le fraisage seul reste hors du recalage d'AR.
    const effectifFraisage = authorizationRole("Employee", ["Fraisage"]);
    expect(roleHasOfCapability(effectifFraisage, "ar_recalage")).toBe(false);
  });

  it("refuse par défaut un rôle vide ou inconnu", () => {
    expect(roleHasOfCapability(null, "revise")).toBe(false);
    expect(roleHasOfCapability("", "document")).toBe(false);
    expect(roleHasOfCapability("Stagiaire", "plan_validate")).toBe(false);
  });
});
