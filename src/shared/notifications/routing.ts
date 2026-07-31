// Routage des notifications internes.
//
// Qui est prévenu d'un sujet donné est une **donnée de configuration**, jamais une
// constante du code. Une personne nommée — « prévenir Ghislaine quand un AR doit
// être recalé » — est destinataire parce qu'elle porte un rôle, ou parce qu'un
// administrateur l'a explicitement désignée dans `notification_routing`.
//
// Coder une identité en dur aurait trois défauts : la notification suit la
// personne et non la fonction, un départ ou une absence casse silencieusement la
// chaîne, et le changement exige une livraison au lieu d'un clic.

/** Sujets de notification connus du domaine OF / planning / AR. */
export const NOTIFICATION_TOPICS = {
  /** Dérive de temps d'usinage au-delà du seuil : le planificateur arbitre. */
  OF_TIME_VARIANCE: "OF_TIME_VARIANCE",
  /** Brouillon de planning soumis à validation. */
  OF_PLANNING_SUBMITTED: "OF_PLANNING_SUBMITTED",
  /** Dossier d'AR client à recaler : l'administration des ventes reprend contact. */
  AR_RECALAGE: "AR_RECALAGE",
} as const;

export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[keyof typeof NOTIFICATION_TOPICS];

/** Une règle de routage : une cible par rôle **ou** une identité désignée. */
export type NotificationRoutingRule = {
  topic: string;
  roleKey: string | null;
  userId: number | null;
  isActive: boolean;
};

/** Un compte et les rôles qu'il porte (rôle principal + rôles additifs #315). */
export type NotificationCandidate = {
  userId: number;
  roles: string[];
};

/**
 * Résout les destinataires d'un sujet.
 *
 * Les identités désignées et les porteurs des rôles configurés sont réunis, puis
 * dédoublonnés : une personne à la fois désignée et porteuse du rôle reçoit une
 * seule notification.
 */
export function resolveNotificationRecipients(args: {
  topic: string;
  rules: NotificationRoutingRule[];
  candidates: NotificationCandidate[];
}): number[] {
  const active = args.rules.filter((rule) => rule.isActive && rule.topic === args.topic);
  if (!active.length) return [];

  const roleKeys = new Set(
    active
      .filter((rule) => rule.roleKey !== null)
      .map((rule) => normalizeRole(rule.roleKey as string))
  );

  const recipients = new Set<number>();

  for (const rule of active) {
    if (rule.userId !== null) recipients.add(rule.userId);
  }

  if (roleKeys.size) {
    for (const candidate of args.candidates) {
      if (candidate.roles.some((role) => roleKeys.has(normalizeRole(role)))) {
        recipients.add(candidate.userId);
      }
    }
  }

  return [...recipients].sort((a, b) => a - b);
}

/**
 * Comparaison de rôle insensible à la casse et aux accents.
 *
 * Le catalogue de rôles mêle « Qualité » et « Responsable Qualité », saisis à la
 * main dans plusieurs écrans ; un routage qui échouerait sur un accent laisserait
 * une alerte sans destinataire, sans erreur visible.
 */
function normalizeRole(role: string): string {
  return role
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

/**
 * Clé de déduplication d'une notification.
 *
 * `app_notifications` porte un index unique sur (user_id, dedupe_key) : rejouer
 * la même décision ne produit pas une seconde notification. C'est ce qui rend
 * l'ensemble idempotent de bout en bout.
 */
export function notificationDedupeKey(topic: string, ...parts: Array<string | number | null>): string {
  return [topic, ...parts.map((part) => (part === null ? "" : String(part)))].join(":");
}

export type NotificationDraft = {
  topic: string;
  kind: string;
  title: string;
  message: string;
  severity: "info" | "success" | "warning" | "error";
  actionUrl: string | null;
  actionLabel: string | null;
  payload: Record<string, unknown>;
  dedupeKey: string;
};

/**
 * Notification interne : aucune de ces notifications ne sort de CERP.
 *
 * Le rappel n'est pas décoratif — le dossier d'AR à recaler concerne un client, et
 * la frontière entre « prévenir l'ADV » et « écrire au client » doit rester nette.
 */
export function buildInternalNotification(draft: NotificationDraft): NotificationDraft {
  return draft;
}
