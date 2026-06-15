export const COMMANDE_WORKFLOW_STATUSES = [
  "BROUILLON",
  "EN_ANALYSE",
  "ATTENTE_TECHNIQUE",
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
] as const;

export type CommandeWorkflowStatus = (typeof COMMANDE_WORKFLOW_STATUSES)[number];

export const COMMANDE_WORKFLOW_STATUS_ORDER: Record<CommandeWorkflowStatus, number> = {
  BROUILLON: 0,
  EN_ANALYSE: 1,
  ATTENTE_TECHNIQUE: 2,
  ATTENTE_PLANNING: 3,
  PLANNING_VALIDE: 4,
  AR_PRET: 5,
  AR_ENVOYE: 6,
  EN_PRODUCTION: 7,
  PRODUCTION_TERMINEE: 8,
  CONTROLE_QUALITE: 9,
  PRET_LIVRAISON: 10,
  LIVRE: 11,
  FACTURE: 12,
  ARCHIVE: 13,
  BLOQUE: 99,
};

const LEGACY_STATUS_ALIASES: Record<string, CommandeWorkflowStatus> = {
  ENREGISTREE: "EN_ANALYSE",
  PLANIFIEE: "PLANNING_VALIDE",
  AR_ENVOYEE: "AR_ENVOYE",
  LIVREE: "LIVRE",
};

export function normalizeCommandeWorkflowStatus(value: unknown): CommandeWorkflowStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if ((COMMANDE_WORKFLOW_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as CommandeWorkflowStatus;
  }
  return LEGACY_STATUS_ALIASES[normalized] ?? null;
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
    description: "Faisabilite, article, piece technique, gamme et besoin de fabrication valides.",
    responsible_role: "technique",
    sort_order: 30,
    status_when_done: "ATTENTE_PLANNING",
    action_key: "complete_technical_analysis",
    action_label: "Valider technique",
  },
  {
    code: "of_generation",
    label: "Generation OF",
    description: "Affaires, allocations et ordres de fabrication prepares depuis les lignes commande.",
    responsible_role: "technique",
    sort_order: 40,
    status_when_done: "ATTENTE_PLANNING",
    action_key: "mark_of_ready",
    action_label: "OF prets",
  },
  {
    code: "planning_validation",
    label: "Validation planning",
    description: "Charges, ressources, machines et jalons atelier confirmes.",
    responsible_role: "planning",
    sort_order: 50,
    status_when_done: "PLANNING_VALIDE",
    action_key: "validate_planning",
    action_label: "Valider planning",
  },
  {
    code: "ar_preparation",
    label: "Preparation AR",
    description: "Accuse de reception client pret avec delais et conditions confirmes.",
    responsible_role: "secretariat",
    sort_order: 60,
    status_when_done: "AR_PRET",
    action_key: "prepare_ar",
    action_label: "AR pret",
  },
  {
    code: "ar_sent",
    label: "Envoi AR",
    description: "AR envoye au client et trace dans le dossier commande.",
    responsible_role: "secretariat",
    sort_order: 70,
    status_when_done: "AR_ENVOYE",
    action_key: "mark_ar_sent",
    action_label: "Marquer AR envoye",
  },
  {
    code: "production_launch",
    label: "Production lancee",
    description: "Ordres de fabrication engages en atelier.",
    responsible_role: "production",
    sort_order: 80,
    status_when_done: "EN_PRODUCTION",
    action_key: "start_production",
    action_label: "Lancer production",
  },
  {
    code: "production_completion",
    label: "Production terminee",
    description: "Fabrication terminee et pieces disponibles pour controle.",
    responsible_role: "production",
    sort_order: 90,
    status_when_done: "PRODUCTION_TERMINEE",
    action_key: "complete_production",
    action_label: "Terminer production",
  },
  {
    code: "quality_control",
    label: "Controle qualite",
    description: "Controle final, non-conformites et liberation qualite traites.",
    responsible_role: "qualite",
    sort_order: 100,
    status_when_done: "PRET_LIVRAISON",
    action_key: "validate_quality",
    action_label: "Liberer livraison",
  },
  {
    code: "delivery",
    label: "Livraison",
    description: "Bon de livraison emis et expedition confirmee.",
    responsible_role: "logistique",
    sort_order: 110,
    status_when_done: "LIVRE",
    action_key: "mark_delivered",
    action_label: "Marquer livre",
  },
  {
    code: "invoicing",
    label: "Facturation",
    description: "Facture client creee et rattachee a la commande.",
    responsible_role: "comptabilite",
    sort_order: 120,
    status_when_done: "FACTURE",
    action_key: "mark_invoiced",
    action_label: "Marquer facture",
  },
  {
    code: "archive",
    label: "Archivage",
    description: "Dossier clos, trace et conserve selon les regles ERP.",
    responsible_role: "direction",
    sort_order: 130,
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
