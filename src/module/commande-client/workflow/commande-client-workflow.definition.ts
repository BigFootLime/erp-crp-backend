export const COMMANDE_WORKFLOW_STATUSES = [
  "BROUILLON",
  "EN_ANALYSE",
  "ATTENTE_TECHNIQUE",
  "ATTENTE_STOCK",
  "ATTENTE_OF",
  "ATTENTE_PLANNING",
  "PLANNING_VALIDE",
  "AR_PRET",
  "AR_ENVOYE",
  "EN_PRODUCTION",
  "PRODUCTION_TERMINEE",
  "CONTROLE_QUALITE",
  "PRET_LIVRAISON",
  "LIVRE",
  "FACTURE",
  "ARCHIVE",
  "BLOQUE",
  "ANNULE",
] as const;

export type CommandeWorkflowStatus = (typeof COMMANDE_WORKFLOW_STATUSES)[number];

export const COMMANDE_WORKFLOW_STATUS_LABELS: Record<CommandeWorkflowStatus, string> = {
  BROUILLON: "Brouillon",
  EN_ANALYSE: "En analyse",
  ATTENTE_TECHNIQUE: "Attente technique",
  ATTENTE_STOCK: "Attente contrôle stock",
  ATTENTE_OF: "Attente lancement",
  ATTENTE_PLANNING: "Attente planning",
  PLANNING_VALIDE: "Planning validé",
  AR_PRET: "AR prêt",
  AR_ENVOYE: "AR envoyé",
  EN_PRODUCTION: "En production",
  PRODUCTION_TERMINEE: "Production terminée",
  CONTROLE_QUALITE: "Contrôle qualité",
  PRET_LIVRAISON: "Prêt livraison",
  LIVRE: "Livré",
  FACTURE: "Facturé",
  ARCHIVE: "Archivé",
  BLOQUE: "Bloqué",
  ANNULE: "Annulé",
};

export const COMMANDE_WORKFLOW_STATUS_ORDER: Record<CommandeWorkflowStatus, number> = {
  BROUILLON: 0,
  EN_ANALYSE: 1,
  ATTENTE_TECHNIQUE: 2,
  ATTENTE_STOCK: 3,
  ATTENTE_OF: 4,
  ATTENTE_PLANNING: 5,
  PLANNING_VALIDE: 6,
  AR_PRET: 7,
  AR_ENVOYE: 8,
  EN_PRODUCTION: 9,
  PRODUCTION_TERMINEE: 10,
  CONTROLE_QUALITE: 11,
  PRET_LIVRAISON: 12,
  LIVRE: 13,
  FACTURE: 14,
  ARCHIVE: 15,
  BLOQUE: 99,
  ANNULE: 100,
};

export const COMMANDE_WORKFLOW_LEGACY_STATUS_ALIASES: Record<string, CommandeWorkflowStatus> = {
  ENREGISTREE: "EN_ANALYSE",
  PLANIFIEE: "PLANNING_VALIDE",
  AR_ENVOYEE: "AR_ENVOYE",
  LIVREE: "LIVRE",
};

export const COMMANDE_WORKFLOW_TRANSITION_CAUSES = [
  "checkpoint",
  "customer_order_launch",
  "internal_order_launch",
  "internal_planning_validation",
  "internal_production_launch",
  "internal_archive",
  "planning_sync",
  "ar_send",
  "shipment_sync",
  "invoice_sync",
  "block",
  "resume",
  "cancel",
] as const;

export type CommandeWorkflowTransitionCause = (typeof COMMANDE_WORKFLOW_TRANSITION_CAUSES)[number];

export type CommandeWorkflowTransitionRule = {
  from: CommandeWorkflowStatus;
  to: CommandeWorkflowStatus;
  cause: CommandeWorkflowTransitionCause;
};

const CHECKPOINT_TRANSITIONS: CommandeWorkflowTransitionRule[] = [
  { from: "BROUILLON", to: "EN_ANALYSE", cause: "checkpoint" },
  { from: "EN_ANALYSE", to: "ATTENTE_TECHNIQUE", cause: "checkpoint" },
  { from: "ATTENTE_TECHNIQUE", to: "ATTENTE_STOCK", cause: "checkpoint" },
  { from: "ATTENTE_STOCK", to: "ATTENTE_OF", cause: "checkpoint" },
  { from: "ATTENTE_PLANNING", to: "PLANNING_VALIDE", cause: "checkpoint" },
  { from: "PLANNING_VALIDE", to: "AR_PRET", cause: "checkpoint" },
  { from: "AR_ENVOYE", to: "EN_PRODUCTION", cause: "checkpoint" },
  { from: "EN_PRODUCTION", to: "PRODUCTION_TERMINEE", cause: "checkpoint" },
  // The quality checkpoint owns the release decision. CONTROLE_QUALITE remains
  // readable for historical/integration data, while the UI action may release
  // directly from PRODUCTION_TERMINEE once the quality artifact is complete.
  { from: "PRODUCTION_TERMINEE", to: "PRET_LIVRAISON", cause: "checkpoint" },
  { from: "CONTROLE_QUALITE", to: "PRET_LIVRAISON", cause: "checkpoint" },
  { from: "PRET_LIVRAISON", to: "LIVRE", cause: "checkpoint" },
  { from: "LIVRE", to: "FACTURE", cause: "checkpoint" },
  { from: "FACTURE", to: "ARCHIVE", cause: "checkpoint" },
];

const CANCELLATION_TRANSITIONS: CommandeWorkflowTransitionRule[] = COMMANDE_WORKFLOW_STATUSES
  .filter((status) => !["LIVRE", "FACTURE", "ARCHIVE", "ANNULE"].includes(status))
  .map((from) => ({ from, to: "ANNULE", cause: "cancel" }));

export const COMMANDE_WORKFLOW_BLOCKABLE_STATUSES = COMMANDE_WORKFLOW_STATUSES.filter(
  (status): status is Exclude<CommandeWorkflowStatus, "ARCHIVE" | "BLOQUE" | "ANNULE"> =>
    status !== "ARCHIVE" && status !== "BLOQUE" && status !== "ANNULE"
);

export const COMMANDE_WORKFLOW_TRANSITIONS: readonly CommandeWorkflowTransitionRule[] = [
  ...CHECKPOINT_TRANSITIONS,
  ...CANCELLATION_TRANSITIONS,
  { from: "ATTENTE_OF", to: "ATTENTE_PLANNING", cause: "customer_order_launch" },
  { from: "ATTENTE_OF", to: "PRET_LIVRAISON", cause: "customer_order_launch" },
  // A legacy invalid planning state can be recovered by reopening the launch
  // checkpoint while its append-only status history remains ATTENTE_PLANNING.
  { from: "ATTENTE_PLANNING", to: "PRET_LIVRAISON", cause: "customer_order_launch" },
  { from: "ATTENTE_TECHNIQUE", to: "ATTENTE_PLANNING", cause: "internal_order_launch" },
  // Commands saved by the former guided flow may already have completed one
  // or both customer-only preparation checkpoints. Keep their launch
  // recoverable under the same INTERNE-only cause.
  { from: "ATTENTE_STOCK", to: "ATTENTE_PLANNING", cause: "internal_order_launch" },
  { from: "ATTENTE_OF", to: "ATTENTE_PLANNING", cause: "internal_order_launch" },
  { from: "ATTENTE_PLANNING", to: "PLANNING_VALIDE", cause: "internal_planning_validation" },
  { from: "PLANNING_VALIDE", to: "EN_PRODUCTION", cause: "internal_production_launch" },
  { from: "LIVRE", to: "ARCHIVE", cause: "internal_archive" },
  { from: "ATTENTE_PLANNING", to: "PLANNING_VALIDE", cause: "planning_sync" },
  { from: "AR_PRET", to: "AR_ENVOYE", cause: "ar_send" },
  { from: "PRET_LIVRAISON", to: "LIVRE", cause: "shipment_sync" },
  { from: "LIVRE", to: "FACTURE", cause: "invoice_sync" },
];

export type CommandeWorkflowTransitionContext = {
  resume_status?: CommandeWorkflowStatus | null;
};

export function isCanonicalCommandeWorkflowStatus(value: unknown): value is CommandeWorkflowStatus {
  return typeof value === "string" && (COMMANDE_WORKFLOW_STATUSES as readonly string[]).includes(value);
}

export function canCommandeWorkflowTransition(
  from: CommandeWorkflowStatus,
  to: CommandeWorkflowStatus,
  cause: CommandeWorkflowTransitionCause,
  context: CommandeWorkflowTransitionContext = {}
): boolean {
  if (from === to) return true;
  if (cause === "block") {
    return to === "BLOQUE" && (COMMANDE_WORKFLOW_BLOCKABLE_STATUSES as readonly string[]).includes(from);
  }
  if (cause === "resume") {
    return from === "BLOQUE" && context.resume_status === to;
  }
  if (cause === "cancel") {
    return to === "ANNULE" && !["LIVRE", "FACTURE", "ARCHIVE", "ANNULE"].includes(from);
  }
  return COMMANDE_WORKFLOW_TRANSITIONS.some(
    (transition) => transition.from === from && transition.to === to && transition.cause === cause
  );
}

export function getAllowedCommandeWorkflowTransitions(from: CommandeWorkflowStatus): readonly CommandeWorkflowStatus[] {
  return [...new Set(
    COMMANDE_WORKFLOW_TRANSITIONS
      .filter((transition) => transition.from === from && transition.cause === "checkpoint")
      .map((transition) => transition.to)
  )];
}

export function normalizeCommandeWorkflowStatus(value: unknown): CommandeWorkflowStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if ((COMMANDE_WORKFLOW_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as CommandeWorkflowStatus;
  }
  return COMMANDE_WORKFLOW_LEGACY_STATUS_ALIASES[normalized] ?? null;
}

export const COMMANDE_CHECKPOINT_STATUSES = ["pending", "active", "blocked", "done", "skipped"] as const;
export type CommandeCheckpointStatus = (typeof COMMANDE_CHECKPOINT_STATUSES)[number];

export type CommandeResponsibleRole =
  | "secretariat"
  | "technique"
  | "planning"
  | "production"
  | "qualite"
  | "logistique"
  | "comptabilite"
  | "direction";

export type CommandeWorkflowCheckpointDefinition = {
  code: string;
  label: string;
  description: string;
  responsible_role: CommandeResponsibleRole;
  sort_order: number;
  status_when_done: CommandeWorkflowStatus;
  action_key: string;
  action_label: string;
};

export const COMMANDE_WORKFLOW_CHECKPOINTS: CommandeWorkflowCheckpointDefinition[] = [
  {
    code: "order_intake",
    label: "Saisie commande",
    description: "Commande client capturee, lignes et pieces client rattachees.",
    responsible_role: "secretariat",
    sort_order: 10,
    status_when_done: "EN_ANALYSE",
    action_key: "start_analysis",
    action_label: "Lancer analyse",
  },
  {
    code: "commercial_review",
    label: "Analyse administrative",
    description: "Client, conditions, delais et documents verifies avant passage technique.",
    responsible_role: "secretariat",
    sort_order: 20,
    status_when_done: "ATTENTE_TECHNIQUE",
    action_key: "request_technical_analysis",
    action_label: "Demander analyse technique",
  },
  {
    code: "technical_analysis",
    label: "Analyse technique",
    description: "Faisabilite, article, piece technique et gamme valides par les methodes, sans planification.",
    responsible_role: "technique",
    sort_order: 30,
    status_when_done: "ATTENTE_STOCK",
    action_key: "complete_technical_analysis",
    action_label: "Valider technique",
  },
  {
    code: "stock_check",
    label: "Controle du stock",
    description: "Disponibilite controlee dans la Base old puis dans la Base new avant toute proposition d'OF.",
    responsible_role: "technique",
    sort_order: 40,
    status_when_done: "ATTENTE_OF",
    action_key: "check_stock",
    action_label: "Controler le stock",
  },
  {
    code: "of_generation",
    label: "Lancement commande",
    description: "Affaires et allocations sont preparees depuis les lignes commande ; les OF ne sont crees que pour le manque de stock.",
    responsible_role: "technique",
    sort_order: 50,
    status_when_done: "ATTENTE_PLANNING",
    action_key: "mark_of_ready",
    action_label: "Vérifier le stock et lancer",
  },
  {
    code: "planning_validation",
    label: "Validation planning",
    description: "Charges, ressources, machines et jalons atelier confirmes.",
    responsible_role: "planning",
    sort_order: 60,
    status_when_done: "PLANNING_VALIDE",
    action_key: "validate_planning",
    action_label: "Valider planning",
  },
  {
    code: "ar_preparation",
    label: "Preparation AR",
    description: "Accuse de reception client pret avec delais et conditions confirmes.",
    responsible_role: "secretariat",
    sort_order: 70,
    status_when_done: "AR_PRET",
    action_key: "prepare_ar",
    action_label: "AR pret",
  },
  {
    code: "ar_sent",
    label: "Envoi AR",
    description: "AR envoye au client et trace dans le dossier commande.",
    responsible_role: "secretariat",
    sort_order: 80,
    status_when_done: "AR_ENVOYE",
    action_key: "mark_ar_sent",
    action_label: "Marquer AR envoye",
  },
  {
    code: "production_launch",
    label: "Production lancee",
    description: "Ordres de fabrication engages en atelier.",
    responsible_role: "production",
    sort_order: 90,
    status_when_done: "EN_PRODUCTION",
    action_key: "start_production",
    action_label: "Lancer production",
  },
  {
    code: "production_completion",
    label: "Production terminee",
    description: "Fabrication terminee et pieces disponibles pour controle.",
    responsible_role: "production",
    sort_order: 100,
    status_when_done: "PRODUCTION_TERMINEE",
    action_key: "complete_production",
    action_label: "Terminer production",
  },
  {
    code: "quality_control",
    label: "Controle qualite",
    description: "Controle final, non-conformites et liberation qualite traites.",
    responsible_role: "qualite",
    sort_order: 110,
    status_when_done: "PRET_LIVRAISON",
    action_key: "validate_quality",
    action_label: "Liberer livraison",
  },
  {
    code: "delivery",
    label: "Livraison",
    description: "Bon de livraison emis et expedition confirmee.",
    responsible_role: "logistique",
    sort_order: 120,
    status_when_done: "LIVRE",
    action_key: "mark_delivered",
    action_label: "Marquer livre",
  },
  {
    code: "invoicing",
    label: "Facturation",
    description: "Facture client creee et rattachee a la commande.",
    responsible_role: "comptabilite",
    sort_order: 130,
    status_when_done: "FACTURE",
    action_key: "mark_invoiced",
    action_label: "Marquer facture",
  },
  {
    code: "archive",
    label: "Archivage",
    description: "Dossier clos, trace et conserve selon les regles ERP.",
    responsible_role: "direction",
    sort_order: 140,
    status_when_done: "ARCHIVE",
    action_key: "archive",
    action_label: "Archiver",
  },
];

export type CommandeWorkflowAction = {
  key: string;
  label: string;
  checkpoint_code: string;
  target_status: CommandeWorkflowStatus;
  next_checkpoint_code: string | null;
};

export const COMMANDE_WORKFLOW_ACTIONS: CommandeWorkflowAction[] = COMMANDE_WORKFLOW_CHECKPOINTS.map((checkpoint, index) => ({
  key: checkpoint.action_key,
  label: checkpoint.action_label,
  checkpoint_code: checkpoint.code,
  target_status: checkpoint.status_when_done,
  next_checkpoint_code: COMMANDE_WORKFLOW_CHECKPOINTS[index + 1]?.code ?? null,
}));

export function getCommandeWorkflowCheckpointDefinition(code: string) {
  const normalized = code.trim();
  return COMMANDE_WORKFLOW_CHECKPOINTS.find((checkpoint) => checkpoint.code === normalized) ?? null;
}

export function getCommandeWorkflowAction(key: string) {
  const normalized = key.trim();
  return COMMANDE_WORKFLOW_ACTIONS.find((action) => action.key === normalized) ?? null;
}

export const COMMANDE_WORKFLOW_CONTRACT = {
  schema_version: "1.0.0",
  authority: "erp-crp-backend",
  statuses: COMMANDE_WORKFLOW_STATUSES,
  status_labels: COMMANDE_WORKFLOW_STATUS_LABELS,
  status_order: COMMANDE_WORKFLOW_STATUS_ORDER,
  checkpoint_statuses: COMMANDE_CHECKPOINT_STATUSES,
  legacy_status_aliases: COMMANDE_WORKFLOW_LEGACY_STATUS_ALIASES,
  checkpoint_transitions: Object.fromEntries(
    COMMANDE_WORKFLOW_STATUSES.map((status) => [status, getAllowedCommandeWorkflowTransitions(status)])
  ) as Record<CommandeWorkflowStatus, readonly CommandeWorkflowStatus[]>,
  transition_rules: COMMANDE_WORKFLOW_TRANSITIONS,
  transition_policies: {
    block: {
      from: "active checkpoint current status",
      to: "BLOQUE",
    },
    resume: {
      from: "BLOQUE",
      to: "checkpoint metadata.previous_status_before_block",
    },
    system_replays: {
      shipment_sync: ["LIVRE", "FACTURE", "ARCHIVE"],
      invoice_sync: ["FACTURE", "ARCHIVE"],
      planning_sync: [
        "PLANNING_VALIDE",
        "AR_PRET",
        "AR_ENVOYE",
        "EN_PRODUCTION",
        "PRODUCTION_TERMINEE",
        "CONTROLE_QUALITE",
        "PRET_LIVRAISON",
        "LIVRE",
        "FACTURE",
        "ARCHIVE",
      ],
    },
  },
  checkpoints: COMMANDE_WORKFLOW_CHECKPOINTS,
} as const;
