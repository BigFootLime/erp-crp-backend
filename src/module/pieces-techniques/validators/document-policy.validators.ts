// src/module/pieces-techniques/validators/document-policy.validators.ts
// Issue #227 — contrats d'entrée de la politique documentaire et des brouillons.
import { z } from "zod";

import { CLIENT_DOCUMENT_POLICIES } from "../domain/document-policy";

const uuid = z.string().uuid();

export const clientDocumentPolicySchema = z.enum(CLIENT_DOCUMENT_POLICIES);

/** `client_id` CERP : varchar(3) dans public.clients — la borne vient du schéma. */
export const clientIdParamSchema = z.object({
  params: z.object({ clientId: z.string().trim().min(1).max(3) }),
});

export const setClientDocumentPolicySchema = z.object({
  body: z.object({
    policy: clientDocumentPolicySchema,
    /**
     * Vide = tous les types actifs du référentiel. Une sélection explicite restreint.
     * On dédoublonne ici pour que la base ne reçoive jamais deux fois le même code.
     */
    selected_type_codes: z
      .array(z.string().trim().min(1).max(50))
      .max(100)
      .optional()
      .default([])
      .transform((codes) => [...new Set(codes)]),
  }),
});
export type SetClientDocumentPolicyBodyDTO = z.infer<typeof setClientDocumentPolicySchema>["body"];

/** Instantané gelé consultable par identifiant de version seul, hors contexte de pièce. */
export const versionIdOnlyParamSchema = z.object({ params: z.object({ versionId: uuid }) });

export const documentTypeCodeParamSchema = z.object({
  params: z.object({ code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,49}$/, "Code invalide") }),
});

export const createDocumentTypeSchema = z.object({
  body: z.object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{1,49}$/, "Le code doit être en MAJUSCULES, chiffres et tirets bas (ex. CERTIF_SOUDURE)."),
    label: z.string().trim().min(1, "Libellé requis").max(200),
    description: z.string().trim().max(2000).optional().nullable(),
    ged_class_key: z.string().trim().max(80).optional().nullable(),
    is_active: z.boolean().optional(),
    sort_order: z.coerce.number().int().min(0).max(9999).optional(),
  }),
});
export type CreateDocumentTypeBodyDTO = z.infer<typeof createDocumentTypeSchema>["body"];

export const updateDocumentTypeSchema = z.object({
  body: z.object({
    label: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    ged_class_key: z.string().trim().max(80).optional().nullable(),
    is_active: z.boolean().optional(),
    sort_order: z.coerce.number().int().min(0).max(9999).optional(),
  }),
});
export type UpdateDocumentTypeBodyDTO = z.infer<typeof updateDocumentTypeSchema>["body"];

export const setPieceCritiqueSchema = z.object({
  body: z.object({
    piece_critique: z.boolean(),
    motif: z.string().trim().max(2000).optional().nullable(),
  }),
});
export type SetPieceCritiqueBodyDTO = z.infer<typeof setPieceCritiqueSchema>["body"];

/* ----------------------------- Brouillons ------------------------------- */

export const draftIdParamSchema = z.object({ params: z.object({ draftId: uuid }) });

export const saveDraftSchema = z.object({
  body: z.object({
    /** Étiquette lisible pour retrouver son brouillon dans la liste. */
    title: z.string().trim().max(200).optional().nullable(),
    /**
     * Contenu opaque du parcours. Borné à 256 Ko : un brouillon est une saisie en cours,
     * pas un dépôt de fichiers. Au-delà, c'est un signe que la donnée est au mauvais endroit.
     */
    payload: z.record(z.unknown()).refine(
      (value) => JSON.stringify(value).length <= 256 * 1024,
      "Brouillon trop volumineux (256 Ko maximum)."
    ),
    current_step: z.string().trim().max(60).optional().nullable(),
  }),
});
export type SaveDraftBodyDTO = z.infer<typeof saveDraftSchema>["body"];
