// Validateurs du poste opérateur tablette (#159).
//
// Principe hérité de #274 et renforcé ici : le serveur ne fait jamais confiance
// au client sur l'identité, le temps ni les identifiants.
//
//   * L'OPÉRATEUR d'une session vient du support d'identification vérifié côté
//     serveur, jamais d'un `user_id` envoyé par le navigateur.
//   * Le CODE PUBLIC d'un appareil est généré par la base à l'enrôlement.
//   * Le JETON de session est opaque et généré par le serveur.
//   * Les DURÉES de verrouillage et d'expiration sont bornées côté serveur : une
//     tablette ne négocie pas sa propre politique de sécurité.

import { z } from "zod";

import { HANDOVER_MACHINE_STATES, IDENTIFICATION_METHODS } from "../domain/station";

const uuid = z.string().uuid();

const devicePublicCode = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9-]{2,31}$/, "Code d'appareil invalide (ex. TAB-0007)");

const label = z.string().trim().min(2, "Libellé trop court").max(120);
const freeText = z.string().trim().max(2000);
const reason = z.string().trim().min(3, "Motif trop court (3 caractères minimum)").max(2000);

/**
 * Support d'identification brut. Il n'est JAMAIS stocké ni journalisé : il est
 * transformé en empreinte HMAC dès l'entrée du service. La borne haute évite
 * qu'un lecteur défaillant n'envoie un flux entier.
 */
const rawCredential = z.string().trim().min(4, "Support illisible").max(256);

/* -------------------------------------------------------------------------- */
/* Bootstrap et session                                                       */
/* -------------------------------------------------------------------------- */

export const stationBootstrapQuerySchema = z.object({
  /**
   * Code lisible collé sur la tablette. Ce n'est PAS un secret : le connaître
   * n'accorde aucun droit. Toute action reste portée par la session opérateur.
   */
  device_code: devicePublicCode.optional(),
  app_version: z.string().trim().max(40).optional(),
});
export type StationBootstrapQueryDTO = z.infer<typeof stationBootstrapQuerySchema>;

export const stationIdentifySchema = z
  .object({
    device_code: devicePublicCode,
    method: z.enum(IDENTIFICATION_METHODS),
    /** Présent pour BADGE et QR uniquement. Jamais renvoyé, jamais journalisé. */
    credential: rawCredential.optional(),
    /** Anti-rejeu du QR : horodatage d'émission signé côté émetteur. */
    nonce: z.string().trim().min(8).max(128).optional(),
    issued_at: z
      .string()
      .trim()
      .refine((v) => Number.isFinite(Date.parse(v)), "Horodatage invalide")
      .optional(),
    /** Machine proposée par une tablette mobile. Le serveur re-vérifie tout. */
    machine_id: uuid.nullish(),
    app_version: z.string().trim().max(40).optional(),
    /** Décision explicite si un pointage tourne déjà sur ce poste. */
    switch_decision: z.enum(["HANDOVER", "PAUSE", "SUPERVISOR_OVERRIDE"]).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.method === "BADGE" || value.method === "QR") && !value.credential) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credential"],
        message: "Présentez votre badge ou votre code.",
      });
    }
    if (value.method === "QR" && !value.issued_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issued_at"],
        message: "Code QR sans horodatage : rejeu impossible à écarter.",
      });
    }
    // PASSWORD et SSO passent par l'authentification ERP existante : la session
    // de poste est alors ouverte pour l'utilisateur DÉJÀ authentifié, et aucun
    // identifiant supplémentaire n'est accepté ici.
    if ((value.method === "PASSWORD" || value.method === "SSO") && value.credential) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credential"],
        message: "Ce mode d'identification n'accepte aucun secret sur cette route.",
      });
    }
  });
export type StationIdentifyDTO = z.infer<typeof stationIdentifySchema>;

export const stationConfirmMachineSchema = z.object({
  machine_id: uuid,
  /** Reprendre une machine occupée exige une décision, jamais un forçage muet. */
  switch_decision: z.enum(["HANDOVER", "PAUSE", "SUPERVISOR_OVERRIDE"]).optional(),
});
export type StationConfirmMachineDTO = z.infer<typeof stationConfirmMachineSchema>;

export const stationLockSchema = z.object({
  reason: z.enum(["MANUAL", "IDLE", "SHIFT_END"]).default("MANUAL"),
});
export type StationLockDTO = z.infer<typeof stationLockSchema>;

export const stationUnlockSchema = z
  .object({
    method: z.enum(IDENTIFICATION_METHODS),
    credential: rawCredential.optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.method === "BADGE" || value.method === "QR") && !value.credential) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credential"],
        message: "Présentez votre badge pour déverrouiller.",
      });
    }
  });
export type StationUnlockDTO = z.infer<typeof stationUnlockSchema>;

export const stationCloseSchema = z.object({
  reason: z.enum(["MANUAL", "SHIFT_END", "OPERATOR_SWITCH", "ADMIN"]).default("MANUAL"),
  comment: freeText.optional(),
});
export type StationCloseDTO = z.infer<typeof stationCloseSchema>;

export const stationHeartbeatSchema = z.object({
  app_version: z.string().trim().max(40).optional(),
  /**
   * Horodatage local de la tablette. Il sert UNIQUEMENT à détecter une dérive
   * d'horloge et à en avertir l'opérateur ; il ne pilote aucun calcul métier.
   */
  client_time: z
    .string()
    .trim()
    .refine((v) => Number.isFinite(Date.parse(v)), "Horodatage invalide")
    .optional(),
});
export type StationHeartbeatDTO = z.infer<typeof stationHeartbeatSchema>;

/* -------------------------------------------------------------------------- */
/* File de travail et dossier                                                 */
/* -------------------------------------------------------------------------- */

export const stationWorklistQuerySchema = z.object({
  /** Recherche libre : numéro d'OF, code pièce, désignation. */
  q: z.string().trim().max(120).optional(),
  /** Inclure les opérations non prêtes, pour comprendre ce qui bloque. */
  include_blocked: z.coerce.boolean().default(false),
  /**
   * Restreindre à la machine confirmée. Par défaut `true` : un opérateur devant
   * un tour n'a rien à faire de la file de la fraiseuse.
   */
  machine_only: z.coerce.boolean().default(true),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type StationWorklistQueryDTO = z.infer<typeof stationWorklistQuerySchema>;

export const stationDossierParamsSchema = z.object({
  ofId: z.coerce.number().int().positive(),
  operationId: uuid,
});
export type StationDossierParamsDTO = z.infer<typeof stationDossierParamsSchema>;

export const stationScanSchema = z.object({
  /**
   * Contenu du code scanné. Accepte un numéro d'OF, un code opération
   * `OF-2026-0007/30`, ou une URL CERP. Le serveur résout, le client ne devine
   * jamais.
   */
  code: z.string().trim().min(1).max(200),
});
export type StationScanDTO = z.infer<typeof stationScanSchema>;

/* -------------------------------------------------------------------------- */
/* Transmission de poste                                                      */
/* -------------------------------------------------------------------------- */

export const stationHandoverSchema = z.object({
  incoming_user_id: z.number().int().positive(),
  of_id: z.number().int().positive().nullish(),
  operation_id: uuid.nullish(),
  pointage_id: uuid.nullish(),
  machine_state: z.enum(HANDOVER_MACHINE_STATES).default("UNKNOWN"),
  qty_done: z.number().nonnegative().nullish(),
  defects: freeText.optional(),
  tooling_left: freeText.optional(),
  remaining_actions: freeText.optional(),
  comment: freeText.optional(),
});
export type StationHandoverDTO = z.infer<typeof stationHandoverSchema>;

export const stationHandoverAckSchema = z.object({
  comment: freeText.optional(),
});
export type StationHandoverAckDTO = z.infer<typeof stationHandoverAckSchema>;

/* -------------------------------------------------------------------------- */
/* Administration des appareils                                               */
/* -------------------------------------------------------------------------- */

export const enrollDeviceSchema = z
  .object({
    label,
    /** Préfixe du code public. Le NUMÉRO est alloué par la base. */
    code_prefix: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9]{0,7}$/, "Préfixe invalide (ex. TAB)")
      .default("TAB"),
    site: z.string().trim().max(80).optional(),
    workshop_zone: z.string().trim().max(80).optional(),
    assignment_mode: z.enum(["FIXED", "MOBILE"]).default("MOBILE"),
    machine_id: uuid.nullish(),
    // Bornes serveur : une tablette d'atelier ne se déclare pas « jamais
    // verrouillée ».
    auto_lock_seconds: z.number().int().min(30).max(3600).default(180),
    session_max_seconds: z.number().int().min(300).max(86400).default(28800),
  })
  .superRefine((value, ctx) => {
    if (value.assignment_mode === "FIXED" && !value.machine_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["machine_id"],
        message: "Une tablette fixe doit être affectée à une machine.",
      });
    }
  });
export type EnrollDeviceDTO = z.infer<typeof enrollDeviceSchema>;

export const updateDeviceSchema = z
  .object({
    label: label.optional(),
    site: z.string().trim().max(80).nullish(),
    workshop_zone: z.string().trim().max(80).nullish(),
    assignment_mode: z.enum(["FIXED", "MOBILE"]).optional(),
    machine_id: uuid.nullish(),
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
    auto_lock_seconds: z.number().int().min(30).max(3600).optional(),
    session_max_seconds: z.number().int().min(300).max(86400).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Aucune modification demandée.");
export type UpdateDeviceDTO = z.infer<typeof updateDeviceSchema>;

export const revokeDeviceSchema = z.object({ reason });
export type RevokeDeviceDTO = z.infer<typeof revokeDeviceSchema>;

export const listDevicesQuerySchema = z.object({
  status: z.enum(["ACTIVE", "DISABLED", "REVOKED"]).optional(),
  workshop_zone: z.string().trim().max(80).optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListDevicesQueryDTO = z.infer<typeof listDevicesQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Supports d'identification                                                  */
/* -------------------------------------------------------------------------- */

export const issueCredentialSchema = z.object({
  user_id: z.number().int().positive(),
  credential_type: z.enum(["BADGE_NFC", "BADGE_RFID", "QR"]).default("BADGE_NFC"),
  /** Lu par le lecteur au moment de l'émission. Haché immédiatement. */
  credential: rawCredential,
  label: z.string().trim().max(80).optional(),
});
export type IssueCredentialDTO = z.infer<typeof issueCredentialSchema>;

export const revokeCredentialSchema = z.object({ reason });
export type RevokeCredentialDTO = z.infer<typeof revokeCredentialSchema>;

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export const stationAuditQuerySchema = z.object({
  device_id: uuid.optional(),
  user_id: z.coerce.number().int().positive().optional(),
  event_type: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
    .optional(),
  outcome: z.enum(["SUCCESS", "DENIED", "ERROR"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type StationAuditQueryDTO = z.infer<typeof stationAuditQuerySchema>;
