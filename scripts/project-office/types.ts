/** Types du modèle de peuplement Project Office (voir populate-cerp-project.ts). */

export type Target = "test" | "prod";

export type WpType =
  | "EPIC" | "LOT" | "FEATURE" | "BUG" | "AUDIT"
  | "DOC" | "INFRA" | "SECURITY" | "COMPLIANCE" | "TASK";
export type WpStatus =
  | "BACKLOG" | "READY" | "IN_PROGRESS" | "REVIEW" | "BLOCKED" | "DONE" | "CANCELLED";
export type Priority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

export interface WorkPackageDef {
  code: string;
  parent?: string;
  title: string;
  /** Description avec réf. sources (GIT_COMMIT/GITHUB_PR/DOC_SOURCE/MODULE_ANALYSIS) + marquage VALIDÉ / BROUILLON_IA / À_COMPLÉTER / À VALIDER. */
  description?: string;
  type: WpType;
  status: WpStatus;
  priority?: Priority;
  start?: string;
  due?: string;
  progress?: number;
  /** false → pas d'assigné (tâches futures non affectées). Défaut : owner. */
  assign?: boolean;
}

export interface DependencyDef {
  source: string;
  target: string;
  type: "BLOCKS" | "RELATES" | "DUPLICATES" | "REQUIRES";
}

export interface MilestoneDef {
  name: string;
  description: string;
  due: string;
  status: "PLANNED" | "REACHED" | "MISSED" | "CANCELLED";
}

export interface SpecVersionDef {
  version: string;
  content: string;
  changeSummary: string;
  /** Date ISO si la version est approuvée (approbateur = owner). */
  approvedAt?: string;
}

export interface DecisionDef {
  title: string;
  context: string;
  options?: unknown;
  decision: string;
  consequences: string;
  decidedAt: string;
}

export interface RiskDef {
  title: string;
  description: string;
  probability: number; // 1-5
  impact: number; // 1-5
  mitigation: string;
  status: "OPEN" | "MITIGATED" | "ACCEPTED" | "CLOSED";
}

export type EvidenceType =
  | "PR" | "COMMIT" | "TEST" | "SCREENSHOT" | "AUDIT"
  | "DEPLOYMENT" | "BACKUP" | "DOCUMENT" | "SECURITY_SCAN" | "OTHER";

export interface EvidenceDef {
  /** Titre stable et unique dans le projet : contient [SOURCE external_id]. */
  title: string;
  type: EvidenceType;
  wp?: string;
  url?: string;
  description?: string;
}

export interface ActionDef {
  title: string;
  description: string;
  source: "AUDIT" | "BUG" | "RISK" | "SECURITY" | "USER_FEEDBACK" | "OTHER";
  priority: Priority;
  due?: string;
  status: "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";
  evidenceTitle?: string;
}

export interface ExternalLinkDef {
  type: "PR" | "ISSUE" | "COMMIT" | "PIPELINE" | "RELEASE" | "DOC";
  externalId: string;
  url: string;
  status?: string;
}

export type EntryStatus =
  | "VIDE" | "A_DOCUMENTER" | "BROUILLON_IA" | "A_RELIRE"
  | "VALIDE" | "A_RETRAVAILLER" | "EXPORTE";

export interface ReportEntryDef {
  section: string; // section_number du template RAPPORT_BAC5_CERP
  status: EntryStatus;
  progress: number;
  draft?: string;
  notes?: string;
}

export interface ReportEntryEvidenceDef {
  section: string;
  evidenceTitle: string;
  relation:
    | "SOURCE" | "SCREENSHOT" | "TEST" | "BUG" | "FIX"
    | "DECISION" | "DEPLOYMENT" | "ARCHITECTURE" | "UI" | "SECURITY";
}

export interface ReportVersionDef {
  version: string;
  title: string;
  snapshot: unknown;
  markdown?: string;
}

export interface TargetCfg {
  database: string;
  ownerUsername: string;
  projectCode: string;
  /** Préfixe appliqué aux noms/titres racines (règle données de test). */
  prefix: string;
}

export interface PopulationData {
  targets: Record<Target, TargetCfg>;
  project: {
    name: string;
    description: string;
    visibility: "PRIVATE" | "INTERNAL" | "PILOT";
    status: "DRAFT" | "ACTIVE" | "ON_HOLD" | "DONE" | "ARCHIVED";
    startDate: string;
    targetDate: string;
  };
  workPackages: WorkPackageDef[];
  dependencies: DependencyDef[];
  milestones: MilestoneDef[];
  spec: {
    title: string;
    status: "DRAFT" | "REVIEW" | "APPROVED" | "OBSOLETE";
    currentVersion: string;
    versions: SpecVersionDef[];
  };
  decisions: DecisionDef[];
  risks: RiskDef[];
  actions: ActionDef[];
  evidence: EvidenceDef[];
  externalLinks: ExternalLinkDef[];
  report: {
    title: string;
    academicYear: string;
    status: "DRAFT" | "IN_PROGRESS" | "REVIEW" | "APPROVED" | "EXPORTED";
    currentVersion: string;
    entries: ReportEntryDef[];
    entryEvidence: ReportEntryEvidenceDef[];
    versions: ReportVersionDef[];
  };
}
