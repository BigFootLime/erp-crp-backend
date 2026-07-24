import { describe, expect, it } from "vitest";

import {
  COMMANDE_FOURNISSEUR_STATUTS,
  COMMANDE_FOURNISSEUR_TRANSITIONS,
  allowedTargetsFrom,
  classifyTransition,
  isAllowedTransition,
  isReceptionDerivedStatut,
  isTerminalStatut,
  transitionRequiresMotif,
  type CommandeFournisseurStatut,
} from "../module/commande-fournisseur/domain/commande-fournisseur-transitions";
import {
  capabilityForTransition,
  roleHasCommandeFournisseurCapability,
} from "../module/commande-fournisseur/domain/commande-fournisseur-rbac";
import {
  computeCommandeTotaux,
  computeLigneTotaux,
  roundMoney,
} from "../module/commande-fournisseur/domain/commande-fournisseur-totaux";
import {
  sha256Hex,
  stableStringify,
} from "../module/commande-fournisseur/repository/commande-fournisseur.repository";

describe("machine d'état commandes fournisseurs (#172)", () => {
  it("couvre exactement les 9 statuts du contrat", () => {
    expect(COMMANDE_FOURNISSEUR_STATUTS).toEqual([
      "BROUILLON",
      "A_VALIDER",
      "APPROUVEE",
      "ENVOYEE",
      "ACCUSE_RECU",
      "PARTIELLEMENT_RECUE",
      "RECUE",
      "CLOTUREE",
      "ANNULEE",
    ]);
  });

  it("CLOTUREE et ANNULEE sont terminaux (aucune sortie)", () => {
    expect(allowedTargetsFrom("CLOTUREE")).toEqual([]);
    expect(allowedTargetsFrom("ANNULEE")).toEqual([]);
    expect(isTerminalStatut("CLOTUREE")).toBe(true);
    expect(isTerminalStatut("ANNULEE")).toBe(true);
    expect(isTerminalStatut("BROUILLON")).toBe(false);
  });

  it("refuse toute transition non déclarée (matrice exhaustive)", () => {
    for (const from of COMMANDE_FOURNISSEUR_STATUTS) {
      for (const to of COMMANDE_FOURNISSEUR_STATUTS) {
        const expected = from !== to && COMMANDE_FOURNISSEUR_TRANSITIONS[from].includes(to);
        expect(isAllowedTransition(from, to)).toBe(expected);
      }
    }
  });

  it("refuse l'auto-transition (double-clic) et les sauts d'étape", () => {
    expect(isAllowedTransition("BROUILLON", "BROUILLON")).toBe(false);
    expect(isAllowedTransition("BROUILLON", "APPROUVEE")).toBe(false);
    expect(isAllowedTransition("BROUILLON", "ENVOYEE")).toBe(false);
    expect(isAllowedTransition("A_VALIDER", "ENVOYEE")).toBe(false);
    expect(isAllowedTransition("ENVOYEE", "BROUILLON")).toBe(false);
    expect(isAllowedTransition("RECUE", "ANNULEE")).toBe(false);
    expect(isAllowedTransition("PARTIELLEMENT_RECUE", "ANNULEE")).toBe(false);
  });

  it("classifie les transitions vers la bonne nature métier", () => {
    expect(classifyTransition("BROUILLON", "A_VALIDER")).toBe("submit");
    expect(classifyTransition("A_VALIDER", "APPROUVEE")).toBe("approve");
    expect(classifyTransition("A_VALIDER", "BROUILLON")).toBe("reject");
    expect(classifyTransition("APPROUVEE", "BROUILLON")).toBe("reopen_draft");
    expect(classifyTransition("APPROUVEE", "ENVOYEE")).toBe("send");
    expect(classifyTransition("ENVOYEE", "ACCUSE_RECU")).toBe("acknowledge");
    expect(classifyTransition("ENVOYEE", "PARTIELLEMENT_RECUE")).toBe("receive_partial");
    expect(classifyTransition("ACCUSE_RECU", "RECUE")).toBe("receive_full");
    expect(classifyTransition("PARTIELLEMENT_RECUE", "CLOTUREE")).toBe("close");
    expect(classifyTransition("BROUILLON", "ANNULEE")).toBe("cancel");
  });

  it("les états de réception sont dérivés, jamais manuels", () => {
    expect(isReceptionDerivedStatut("PARTIELLEMENT_RECUE")).toBe(true);
    expect(isReceptionDerivedStatut("RECUE")).toBe(true);
    expect(isReceptionDerivedStatut("ENVOYEE")).toBe(false);
  });

  it("exige un motif pour annulation, rejet, réédition et clôture", () => {
    expect(transitionRequiresMotif("cancel")).toBe(true);
    expect(transitionRequiresMotif("reject")).toBe(true);
    expect(transitionRequiresMotif("reopen_draft")).toBe(true);
    expect(transitionRequiresMotif("close")).toBe(true);
    expect(transitionRequiresMotif("submit")).toBe(false);
    expect(transitionRequiresMotif("approve")).toBe(false);
    expect(transitionRequiresMotif("send")).toBe(false);
  });
});

describe("RBAC capacités commandes fournisseurs (#172) — refus par défaut", () => {
  const ROLES_REELS = {
    directeur: "Directeur",
    admin: "Administrateur Systeme et Reseau",
    secretaire: "Secretaire",
    prog: "Responsable Programmation",
    qualite: "Responsable Qualité",
    employee: "Employee",
    rh: "RESPONSABLE_RH",
  } as const;

  it("refuse tout pour un rôle vide, null ou inconnu", () => {
    for (const cap of ["read", "create", "approve", "send", "cancel", "prices", "over_receipt"] as const) {
      expect(roleHasCommandeFournisseurCapability(null, cap)).toBe(false);
      expect(roleHasCommandeFournisseurCapability(undefined, cap)).toBe(false);
      expect(roleHasCommandeFournisseurCapability("", cap)).toBe(false);
      expect(roleHasCommandeFournisseurCapability("   ", cap)).toBe(false);
      expect(roleHasCommandeFournisseurCapability("Stagiaire", cap)).toBe(false);
    }
  });

  it("Employee et RESPONSABLE_RH n'ont aucun accès achats", () => {
    for (const cap of ["read", "create", "update_draft", "submit", "approve", "send", "cancel", "close", "export", "prices", "over_receipt"] as const) {
      expect(roleHasCommandeFournisseurCapability(ROLES_REELS.employee, cap)).toBe(false);
      expect(roleHasCommandeFournisseurCapability(ROLES_REELS.rh, cap)).toBe(false);
    }
  });

  it("l'approbation et l'annulation sont réservées Directeur/Admin", () => {
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.directeur, "approve")).toBe(true);
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.admin, "approve")).toBe(true);
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.secretaire, "approve")).toBe(false);
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.prog, "approve")).toBe(false);
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.qualite, "approve")).toBe(false);
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.secretaire, "cancel")).toBe(false);
  });

  it("la Secrétaire et le Resp. Programmation créent/éditent/soumettent, la Qualité lit", () => {
    for (const role of [ROLES_REELS.secretaire, ROLES_REELS.prog]) {
      expect(roleHasCommandeFournisseurCapability(role, "create")).toBe(true);
      expect(roleHasCommandeFournisseurCapability(role, "update_draft")).toBe(true);
      expect(roleHasCommandeFournisseurCapability(role, "submit")).toBe(true);
    }
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.qualite, "read")).toBe(true);
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.qualite, "create")).toBe(false);
  });

  it("la sur-réception est réservée Directeur/Admin/Qualité", () => {
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.qualite, "over_receipt")).toBe(true);
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.directeur, "over_receipt")).toBe(true);
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.secretaire, "over_receipt")).toBe(false);
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.prog, "over_receipt")).toBe(false);
  });

  it("les prix restent masqués à la Qualité (capacité prices)", () => {
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.qualite, "prices")).toBe(false);
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.secretaire, "prices")).toBe(true);
    expect(roleHasCommandeFournisseurCapability(ROLES_REELS.directeur, "prices")).toBe(true);
  });

  it("route chaque nature de transition vers la capacité attendue", () => {
    expect(capabilityForTransition("submit")).toBe("submit");
    expect(capabilityForTransition("approve")).toBe("approve");
    expect(capabilityForTransition("reject")).toBe("approve");
    expect(capabilityForTransition("reopen_draft")).toBe("update_draft");
    expect(capabilityForTransition("send")).toBe("send");
    expect(capabilityForTransition("acknowledge")).toBe("acknowledge");
    expect(capabilityForTransition("close")).toBe("close");
    expect(capabilityForTransition("cancel")).toBe("cancel");
    expect(capabilityForTransition("receive_partial")).toBe("cancel");
    expect(capabilityForTransition("receive_full")).toBe("cancel");
  });
});

describe("totaux serveur (#172) — arrondis testés", () => {
  it("arrondit half away from zero à 2 décimales", () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(10)).toBe(10);
  });

  it("calcule une ligne simple sans dérive flottante", () => {
    const t = computeLigneTotaux({ quantite: 3, prix_unitaire_ht: 19.99, remise_pct: 0, tva_pct: 20, frais_ht: 0 });
    expect(t.brut_ht).toBe(59.97);
    expect(t.remise_montant).toBe(0);
    expect(t.net_ht).toBe(59.97);
    expect(t.tva_montant).toBe(11.99);
    expect(t.ttc).toBe(71.96);
  });

  it("applique remise puis frais puis TVA sur le net", () => {
    const t = computeLigneTotaux({ quantite: 10, prix_unitaire_ht: 12.345, remise_pct: 33.33, tva_pct: 5.5, frais_ht: 2.5 });
    // brut = 123.45 ; remise = 41.15 (123.45*0.3333=41.145... -> 41.15) ; net = 123.45-41.15+2.5 = 84.80
    expect(t.brut_ht).toBe(123.45);
    expect(t.remise_montant).toBe(41.15);
    expect(t.net_ht).toBe(84.8);
    expect(t.tva_montant).toBe(4.66); // 84.80*0.055 = 4.664 -> 4.66
  });

  it("exclut les lignes annulées et ajoute les frais de port avec leur TVA", () => {
    const totaux = computeCommandeTotaux(
      [
        { quantite: 2, prix_unitaire_ht: 100, remise_pct: 10, tva_pct: 20, frais_ht: 0, statut_ligne: "ACTIVE" },
        { quantite: 5, prix_unitaire_ht: 999, remise_pct: 0, tva_pct: 20, frais_ht: 0, statut_ligne: "ANNULEE" },
      ],
      { frais_port_ht: 25, tva_frais_pct: 20 }
    );
    // ligne active : brut 200, remise 20, net 180, tva 36 ; frais 25 (+5 tva)
    expect(totaux.total_ht).toBe(205);
    expect(totaux.total_remise).toBe(20);
    expect(totaux.total_tva).toBe(41);
    expect(totaux.total_ttc).toBe(246);
  });

  it("total vide = frais de port seuls", () => {
    const totaux = computeCommandeTotaux([], { frais_port_ht: 0, tva_frais_pct: 20 });
    expect(totaux).toMatchObject({ total_ht: 0, total_remise: 0, total_tva: 0, total_ttc: 0 });
  });

  it("reste cohérent sur 120 variantes générées (TTC = HT + TVA, centimes exacts)", () => {
    let checked = 0;
    for (let i = 1; i <= 120; i += 1) {
      const quantite = (i % 17) + 0.25;
      const prix = ((i * 7919) % 100000) / 100; // 0.00 .. 999.99
      const remise = i % 3 === 0 ? 33.33 : i % 3 === 1 ? 0 : 12.5;
      const tva = i % 2 === 0 ? 20 : 5.5;
      const frais = (i % 5) * 1.11;
      const totaux = computeCommandeTotaux(
        [{ quantite, prix_unitaire_ht: prix, remise_pct: remise, tva_pct: tva, frais_ht: frais }],
        { frais_port_ht: (i % 4) * 3.33, tva_frais_pct: 20 }
      );
      // Invariants : montants à 2 décimales exactes, TTC = HT + TVA au centime près.
      for (const v of [totaux.total_ht, totaux.total_remise, totaux.total_tva, totaux.total_ttc]) {
        expect(Math.round(v * 100)).toBeCloseTo(v * 100, 6);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(roundMoney(totaux.total_ht + totaux.total_tva)).toBe(totaux.total_ttc);
      checked += 1;
    }
    expect(checked).toBe(120);
  });
});

describe("empreinte documentaire (#172)", () => {
  it("stableStringify est indépendant de l'ordre des clés", () => {
    const a = stableStringify({ b: 1, a: { z: [3, 2], y: null } });
    const b = stableStringify({ a: { y: null, z: [3, 2] }, b: 1 });
    expect(a).toBe(b);
  });

  it("sha256Hex produit une empreinte hexadécimale de 64 caractères, stable", () => {
    const h1 = sha256Hex(stableStringify({ code: "BCF-2026-0001", total: 100 }));
    const h2 = sha256Hex(stableStringify({ total: 100, code: "BCF-2026-0001" }));
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
  });
});
