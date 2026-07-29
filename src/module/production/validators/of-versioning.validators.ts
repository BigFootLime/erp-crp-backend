// Validation d'entrée du chantier #370. Zod, refus explicite, aucun défaut deviné.
//
// Les règles métier (seuil de dérive, transitions, obligation de commentaire sur
// « Autre ») ne sont PAS dupliquées ici : elles vivent dans le domaine, qui est le
// seul juge. Ce fichier vérifie la FORME de la requête, pas sa légitimité — une
// double implémentation finirait par divergier.

import { z } from "zod";

import { AR_RECALAGE_MOTIFS, AR_RECALAGE_STATUTS } from "../domain/ar-recalage";
import { OF_TIME_VARIANCE_CAUSES } from "../domain/of-time-variance";

/** Identifiant d'OF : entier positif. Un `NaN` de `parseInt` est refusé ici. */
export const ofIdParam = z.object({
  ofId: z.coerce.number().int().positive(),
});

export const revisionIdParam = ofIdParam.extend({
  revisionId: z.string().uuid(),
});

export const documentIdParam = ofIdParam.extend({
  documentId: z.string().uuid(),
});

export const planningIdParam = ofIdParam.extend({
  versionId: z.string().uuid(),
});

/** Modification d'une phase, appliquée à la NOUVELLE révision seulement. */
const operationChangeSchema = z.object({
  phase: z.number().int().nonnegative(),
  designation: z.string().trim().min(1).max(300).optional(),
  // La famille est un code du référentiel : la forme est contrainte ici, son
  // existence est vérifiée par le service contre `production_machine_families`.
  family: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]{1,24}$/, "Code de famille machine invalide.")
    .nullable()
    .optional(),
  machineId: z.string().uuid().nullable().optional(),
  // Chaîne vide interdite : un n° de programme vide doit être `null` pour que le
  // document le SIGNALE au lieu de l'imprimer en blanc.
  programme: z.string().trim().min(1).max(120).nullable().optional(),
  tempsUnitaire: z.number().nonnegative().optional(),
  preparation: z.number().nonnegative().optional(),
  quantiteBase: z.number().positive().optional(),
  coefficient: z.number().positive().optional(),
});

export const createRevisionSchema = z.object({
  // Le motif est facultatif pour la forme : c'est le domaine qui l'exige dès R01,
  // parce que la règle dépend du rang, que la requête ne connaît pas.
  motif: z.string().trim().min(3).max(1000).nullable().optional(),
  operations: z.array(operationChangeSchema).max(500).optional(),
});

export const compareRevisionsQuery = z.object({
  from: z.string().uuid(),
  to: z.string().uuid(),
});

export const createVisaSchema = z.object({
  phase: z.number().int().nonnegative(),
  statut: z.enum(["A_FAIRE", "EN_COURS", "VISE", "REFUSE"]),
  initials: z.string().trim().min(1).max(8),
  quantiteBonne: z.number().nonnegative().nullable().optional(),
  quantiteRebut: z.number().nonnegative().nullable().optional(),
  motifRebut: z.string().trim().min(1).max(500).nullable().optional(),
  controleInitials: z.string().trim().min(1).max(8).nullable().optional(),
  comment: z.string().trim().max(1000).nullable().optional(),
});

export const assessVarianceSchema = z.object({
  phase: z.number().int().nonnegative(),
  newTime: z.number().nonnegative(),
});

export const createProposalSchema = z.object({
  phase: z.number().int().nonnegative(),
  newTime: z.number().nonnegative(),
  cause: z.enum(OF_TIME_VARIANCE_CAUSES),
  causeComment: z.string().trim().max(1000).nullable().optional(),
});

export const resolveProposalSchema = z.object({
  statut: z.enum(["ACCEPTEE", "REFUSEE", "CADUQUE"]),
  comment: z.string().trim().max(1000).nullable().optional(),
});

const plannedOperationSchema = z.object({
  phase: z.number().int().nonnegative(),
  designation: z.string().trim().min(1).max(300),
  family: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]{1,24}$/)
    .nullable(),
  machineId: z.string().uuid().nullable(),
  machineLabel: z.string().trim().max(200).nullable(),
  centre: z.string().trim().max(50).nullable().optional(),
  dateDebut: z.string().trim().nullable(),
  dateFin: z.string().trim().nullable(),
  dureeH: z.number().nonnegative(),
  quantite: z.number().nonnegative(),
});

export const createPlanningDraftSchema = z.object({
  payload: z.object({
    operations: z.array(plannedOperationSchema).max(500),
    dateDebut: z.string().trim().nullable(),
    dateFin: z.string().trim().nullable(),
    quantite: z.number().nonnegative(),
    chargeTotaleH: z.number().nonnegative().optional(),
    cadences: z
      .array(
        z.object({
          affaireId: z.number().int(),
          date: z.string().trim(),
          quantite: z.number().nonnegative(),
        })
      )
      .max(500)
      .optional(),
    engagements: z
      .array(
        z.object({
          affaireId: z.number().int(),
          affaireNumero: z.string().nullable(),
          clientId: z.string().nullable(),
          commandeId: z.number().int().nullable(),
          delaiClient: z.string().nullable(),
          nouvelleDate: z.string().nullable(),
        })
      )
      .max(500)
      .optional(),
  }),
  sourceProposalId: z.string().uuid().nullable().optional(),
});

export const planningDecisionSchema = z.object({
  // Le service exige le motif sur un REFUS : la forme l'autorise vide, la règle
  // le refuse, et le message d'erreur explique laquelle des deux a parlé.
  comment: z.string().trim().max(1000).nullable().optional(),
});

const cadenceSchema = z
  .array(z.object({ date: z.string().trim(), quantite: z.number().nonnegative() }))
  .max(500)
  .nullable()
  .optional();

export const createArDossierSchema = z.object({
  affaireId: z.number().int().positive().nullable().optional(),
  previousDate: z.string().trim().nullable().optional(),
  newDate: z.string().trim().nullable().optional(),
  previousCadence: cadenceSchema,
  newCadence: cadenceSchema,
  quantite: z.number().nonnegative().nullable().optional(),
  motif: z.enum(AR_RECALAGE_MOTIFS),
  commentaire: z.string().trim().max(2000).nullable().optional(),
  ownerUserId: z.number().int().positive().nullable().optional(),
});

export const updateArDossierSchema = z.object({
  statut: z.enum(AR_RECALAGE_STATUTS),
  ownerUserId: z.number().int().positive().nullable().optional(),
  commentaire: z.string().trim().max(2000).nullable().optional(),
});

export const emitDocumentSchema = z.object({
  revisionId: z.string().uuid().nullable().optional(),
  // Empreinte vue par l'aperçu. Facultative dans la forme, mais son absence
  // renonce au verrou anti-dérive : l'appelant assume une émission non gardée.
  expectedSnapshotSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
});

export const previewDocumentQuery = z.object({
  revisionId: z.string().uuid().nullable().optional(),
});

export const listArQuery = z.object({
  ofId: z.coerce.number().int().positive().optional(),
  statut: z.enum(AR_RECALAGE_STATUTS).optional(),
});
