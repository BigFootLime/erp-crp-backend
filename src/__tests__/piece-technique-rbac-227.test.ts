/**
 * #227 — RBAC du module Données techniques.
 *
 * Le défaut corrigé : `requireAdmin` testait `role.toLowerCase().includes("admin")`.
 * Ces tests verrouillent les deux sens — les rôles métier légitimes passent, les autres
 * sont refusés — et interdisent le retour de la comparaison par sous-chaîne.
 */
import { describe, expect, it } from "vitest";

import { PRIMARY_USER_ROLES } from "../module/auth/domain/roles";
import {
  canDeletePieceTechnique,
  canManageDocumentPolicy,
  canValidatePieceTechnique,
  canWritePieceTechnique,
  describePieceTechniquePermissions,
  PIECE_DOCUMENT_POLICY_ROLES,
  PIECE_TECHNIQUE_DELETE_ROLES,
  PIECE_TECHNIQUE_VALIDATE_ROLES,
  PIECE_TECHNIQUE_WRITE_ROLES,
} from "../module/pieces-techniques/pieces-techniques.permissions";

const user = (role: string, roles?: string[]) => ({ role, roles });

describe("#227 — validation d'un indice : le défaut « accès refusé » est corrigé", () => {
  it("autorise les rôles qui valident réellement un indice", () => {
    expect(canValidatePieceTechnique(user("Directeur"))).toBe(true);
    expect(canValidatePieceTechnique(user("Responsable Qualité"))).toBe(true);
    expect(canValidatePieceTechnique(user("Responsable Programmation"))).toBe(true);
    expect(canValidatePieceTechnique(user("Administrateur Systeme et Reseau"))).toBe(true);
  });

  it("refuse les rôles sans légitimité sur la donnée technique", () => {
    expect(canValidatePieceTechnique(user("Employee"))).toBe(false);
    expect(canValidatePieceTechnique(user("Secretaire"))).toBe(false);
    expect(canValidatePieceTechnique(user("Responsable RH"))).toBe(false);
    expect(canValidatePieceTechnique(user("Opérateur atelier"))).toBe(false);
    expect(canValidatePieceTechnique(user("Livraison"))).toBe(false);
  });

  it("prend en compte le multi-rôles #315 — un rôle complémentaire suffit", () => {
    // L'ancien garde ne lisait que `role` : un Employee également Responsable Qualité
    // restait bloqué alors que l'organisation lui avait donné la responsabilité.
    expect(canValidatePieceTechnique(user("Employee", ["Qualité"]))).toBe(true);
    expect(canValidatePieceTechnique(user("Employee", ["Directeur Technique"]))).toBe(true);
    expect(canValidatePieceTechnique(user("Employee", ["Livraison"]))).toBe(false);
  });

  it("reconnaît les marqueurs effectifs Méthodes sans ouvrir les rôles atelier", () => {
    expect(canValidatePieceTechnique(user("Employee | Method"))).toBe(true);
    expect(canValidatePieceTechnique(user("Employee | Responsable Programmation"))).toBe(true);
    expect(canValidatePieceTechnique(user("Employee | Opérateur atelier"))).toBe(false);
  });

  it("aucune autorisation par sous-chaîne : un rôle inventé contenant « admin » est refusé", () => {
    expect(canValidatePieceTechnique(user("Stagiaire admin"))).toBe(false);
    expect(canValidatePieceTechnique(user("admin"))).toBe(false);
    expect(canValidatePieceTechnique(user("Administrateur"))).toBe(false);
    expect(canDeletePieceTechnique(user("admin junior"))).toBe(false);
    expect(canWritePieceTechnique(user("ADMINISTRATEUR SYSTEME ET RESEAU"))).toBe(false);
  });

  it("refuse un utilisateur absent, sans rôle ou au rôle vide", () => {
    expect(canValidatePieceTechnique(null)).toBe(false);
    expect(canValidatePieceTechnique(undefined)).toBe(false);
    expect(canValidatePieceTechnique(user(""))).toBe(false);
    expect(canValidatePieceTechnique(user("   "))).toBe(false);
  });
});

describe("#227 — périmètres d'écriture, de politique et de suppression", () => {
  it("l'écriture couvre le bureau d'études et les méthodes", () => {
    expect(canWritePieceTechnique(user("Responsable Programmation"))).toBe(true);
    expect(canWritePieceTechnique(user("Employee", ["Études-Méthodes"]))).toBe(true);
    expect(canWritePieceTechnique(user("Employee", ["Responsable CAO"]))).toBe(true);
    expect(canWritePieceTechnique(user("Secretaire"))).toBe(false);
  });

  it("la politique documentaire est plus étroite que l'écriture", () => {
    // Un programmeur rédige le dossier technique mais n'engage pas ce que le client
    // devra recevoir à la livraison.
    expect(canWritePieceTechnique(user("Responsable Programmation"))).toBe(true);
    expect(canManageDocumentPolicy(user("Responsable Programmation"))).toBe(false);
    expect(canManageDocumentPolicy(user("Responsable Qualité"))).toBe(true);
    expect(canManageDocumentPolicy(user("Directeur"))).toBe(true);
  });

  it("la suppression reste le périmètre le plus étroit", () => {
    expect(canDeletePieceTechnique(user("Directeur"))).toBe(true);
    expect(canDeletePieceTechnique(user("Administrateur Systeme et Reseau"))).toBe(true);
    expect(canDeletePieceTechnique(user("Responsable Qualité"))).toBe(false);
    expect(canDeletePieceTechnique(user("Responsable Programmation"))).toBe(false);
  });

  it("les capacités renvoyées à l'UI décrivent exactement les gardes serveur", () => {
    const directeur = describePieceTechniquePermissions(user("Directeur"));
    expect(directeur).toEqual({
      can_write: true,
      can_validate: true,
      can_manage_document_policy: true,
      can_delete: true,
    });

    const secretaire = describePieceTechniquePermissions(user("Secretaire"));
    expect(secretaire).toEqual({
      can_write: false,
      can_validate: false,
      can_manage_document_policy: false,
      can_delete: false,
    });
  });
});

describe("#227 — garde de gouvernance des listes de rôles", () => {
  const ALL_LISTS = {
    write: PIECE_TECHNIQUE_WRITE_ROLES,
    validate: PIECE_TECHNIQUE_VALIDATE_ROLES,
    policy: PIECE_DOCUMENT_POLICY_ROLES,
    delete: PIECE_TECHNIQUE_DELETE_ROLES,
  };

  it("aucune liste n'est vide — deny by default ne doit pas devenir deny by accident", () => {
    for (const [name, list] of Object.entries(ALL_LISTS)) {
      expect(list.length, `liste ${name}`).toBeGreaterThan(0);
    }
  });

  it("aucune liste ne contient de doublon ni d'entrée vide", () => {
    for (const [name, list] of Object.entries(ALL_LISTS)) {
      expect(new Set(list).size, `liste ${name}`).toBe(list.length);
      expect(list.every((r) => r.trim().length > 0), `liste ${name}`).toBe(true);
    }
  });

  it("les rôles principaux non techniques ne sont dans aucune liste", () => {
    const nonTechnical = PRIMARY_USER_ROLES.filter(
      (r) => r === "Employee" || r === "Secretaire" || r === "Responsable RH"
    );
    for (const role of nonTechnical) {
      for (const [name, list] of Object.entries(ALL_LISTS)) {
        expect((list as readonly string[]).includes(role), `${role} dans ${name}`).toBe(false);
      }
    }
  });

  it("la suppression est incluse dans la validation, jamais l'inverse", () => {
    // Qui peut supprimer peut valider ; qui peut valider ne peut pas forcément supprimer.
    for (const role of PIECE_TECHNIQUE_DELETE_ROLES) {
      expect((PIECE_TECHNIQUE_VALIDATE_ROLES as readonly string[]).includes(role), role).toBe(true);
    }
    expect(PIECE_TECHNIQUE_DELETE_ROLES.length).toBeLessThan(PIECE_TECHNIQUE_VALIDATE_ROLES.length);
  });
});

/**
 * #227 — Garde de transaction.
 *
 * `freezePieceVersionRequirements` s'exécute DANS la transaction qui publie l'indice.
 * Une requête en échec (table absente : 42P01/42703) n'échoue pas seule, elle AVORTE la
 * transaction : tout ce qui suit repart en 25P02, COMMIT compris. Publier un indice se
 * mettrait donc à échouer sur une base sans le patch. Le service doit interroger
 * `to_regclass` — qui ne peut pas échouer — avant de toucher la moindre table.
 */
describe("#227 — publier un indice ne casse pas sur une base sans le référentiel", () => {
  it("interroge to_regclass AVANT toute table, et s'arrête si elles manquent", async () => {
    const { freezePieceVersionRequirements } = await import(
      "../module/pieces-techniques/services/document-policy.service"
    );

    const queries: string[] = [];
    const tx = {
      query: async (sql: string) => {
        queries.push(String(sql));
        if (String(sql).includes("to_regclass")) return { rows: [{ ready: false }], rowCount: 1 };
        throw Object.assign(new Error('relation "public.piece_document_types" does not exist'), {
          code: "42P01",
        });
      },
    } as unknown as import("pg").PoolClient;

    const result = await freezePieceVersionRequirements(tx, {
      pieceTechniqueId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      userId: 1,
    });

    expect(result).toBeNull();
    // Une seule requête, et c'est la sonde inoffensive : aucune table n'a été touchée,
    // donc la transaction de publication reste saine.
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("to_regclass");
  });
});
