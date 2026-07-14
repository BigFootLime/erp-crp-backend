// Types domaine du module Project Office (#130).
// Convention : PK uuid (string), FK utilisateurs = integer (public.users.id).

export type PoMemberRole = "OWNER" | "MANAGER" | "CONTRIBUTOR" | "VIEWER";
export type PoProjectVisibility = "PRIVATE" | "INTERNAL" | "PILOT";
export type PoProjectStatus = "DRAFT" | "ACTIVE" | "ON_HOLD" | "DONE" | "ARCHIVED";
export type PoWpType =
  | "EPIC" | "LOT" | "FEATURE" | "BUG" | "AUDIT"
  | "DOC" | "INFRA" | "SECURITY" | "COMPLIANCE" | "TASK";
export type PoWpStatus = "BACKLOG" | "READY" | "IN_PROGRESS" | "REVIEW" | "BLOCKED" | "DONE" | "CANCELLED";
export type PoPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
export type PoDependencyType = "BLOCKS" | "RELATES" | "DUPLICATES" | "REQUIRES";
export type PoMilestoneStatus = "PLANNED" | "REACHED" | "MISSED" | "CANCELLED";
export type PoSpecStatus = "DRAFT" | "REVIEW" | "APPROVED" | "OBSOLETE";
export type PoRiskStatus = "OPEN" | "MITIGATED" | "ACCEPTED" | "CLOSED";
export type PoActionSource = "AUDIT" | "BUG" | "RISK" | "SECURITY" | "USER_FEEDBACK" | "OTHER";
export type PoActionStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";
export type PoEvidenceType =
  | "PR" | "COMMIT" | "TEST" | "SCREENSHOT" | "AUDIT"
  | "DEPLOYMENT" | "BACKUP" | "DOCUMENT" | "VSM" | "SECURITY_SCAN" | "OTHER";
export type PoLinkProvider = "GITHUB" | "GITLAB" | "OTHER";
export type PoExternalType = "PR" | "ISSUE" | "COMMIT" | "PIPELINE" | "RELEASE" | "DOC";

export type PoReportStatus = "DRAFT" | "IN_PROGRESS" | "REVIEW" | "APPROVED" | "EXPORTED";
export type PoEntryStatus =
  | "VIDE" | "A_DOCUMENTER" | "BROUILLON_IA" | "A_RELIRE"
  | "VALIDE" | "A_RETRAVAILLER" | "EXPORTE";
export type PoEntryEvidenceRelation =
  | "SOURCE" | "SCREENSHOT" | "TEST" | "BUG" | "FIX"
  | "DECISION" | "DEPLOYMENT" | "ARCHITECTURE" | "UI" | "SECURITY";
export type PoAssetType =
  | "SCREENSHOT" | "ERROR_SCREENSHOT" | "UI_SCREENSHOT" | "DIAGRAM"
  | "LOG_EXTRACT" | "TEST_RESULT" | "OTHER";
export type PoExportType = "SECTION_DOCX" | "FULL_DOCX" | "PDF" | "MARKDOWN";
export type PoGenerationMode = "AUTO_FROM_EVIDENCE" | "MANUAL_REGENERATE" | "FULL_REPORT";
export type PoWorkLogAction =
  | "BRANCH_CREATED" | "CODE_CHANGE" | "BUG_FOUND" | "BUG_FIXED" | "TEST_RUN"
  | "DEPLOYMENT" | "MIGRATION" | "REVIEW" | "DOCUMENTATION" | "SCREENSHOT";
export type PoErrorSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type PoErrorStatus = "OPEN" | "FIXED" | "WONT_FIX" | "DUPLICATE";

// Acteur authentifié (dérivé de req.user — jamais du body : anti-IDOR).
export type Actor = { id: number; role: string };

// Accès effectif à un projet : rôle membre effectif ou null (⇒ 404 contrôlé).
export type ProjectAccess = {
  project_id: string;
  visibility: PoProjectVisibility;
  owner_id: number;
  effective_role: PoMemberRole | null;
};

export type ProjectRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  owner_id: number;
  visibility: PoProjectVisibility;
  status: PoProjectStatus;
  start_date: string | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
};

export type MemberRow = {
  id: string;
  project_id: string;
  user_id: number;
  username: string | null;
  role: PoMemberRole;
  created_at: string;
};

export type WorkPackageRow = {
  id: string;
  project_id: string;
  parent_id: string | null;
  code: string;
  title: string;
  description: string | null;
  type: PoWpType;
  status: PoWpStatus;
  priority: PoPriority;
  assignee_id: number | null;
  assignee_username: string | null;
  reporter_id: number | null;
  start_date: string | null;
  due_date: string | null;
  progress_percent: number;
  estimated_hours: string | null;
  spent_hours: string | null;
  created_at: string;
  updated_at: string;
};

export type DependencyRow = {
  id: string;
  source_work_package_id: string;
  target_work_package_id: string;
  dependency_type: PoDependencyType;
  created_at: string;
};

export type MilestoneRow = {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  due_date: string | null;
  status: PoMilestoneStatus;
  created_at: string;
  updated_at: string;
};

export type SpecRow = {
  id: string;
  project_id: string;
  title: string;
  status: PoSpecStatus;
  current_version_id: string | null;
  current_version: string | null;
  created_at: string;
  updated_at: string;
};

export type SpecVersionRow = {
  id: string;
  spec_id: string;
  version: string;
  content_markdown: string;
  change_summary: string | null;
  author_id: number;
  approved_by: number | null;
  approved_at: string | null;
  created_at: string;
};

export type DecisionRow = {
  id: string;
  project_id: string;
  title: string;
  context: string | null;
  options_json: unknown;
  decision: string;
  consequences: string | null;
  decided_by: number | null;
  decided_at: string | null;
  created_at: string;
};

export type RiskRow = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  probability: number;
  impact: number;
  severity: number;
  mitigation: string | null;
  owner_id: number | null;
  status: PoRiskStatus;
  created_at: string;
  updated_at: string;
};

export type ActionRow = {
  id: string;
  project_id: string;
  source_type: PoActionSource;
  title: string;
  description: string | null;
  priority: PoPriority;
  owner_id: number | null;
  due_date: string | null;
  status: PoActionStatus;
  evidence_id: string | null;
  created_at: string;
  updated_at: string;
};

export type EvidenceRow = {
  id: string;
  project_id: string;
  work_package_id: string | null;
  type: PoEvidenceType;
  title: string;
  url: string | null;
  description: string | null;
  created_by: number;
  created_at: string;
};

export type EvidenceFileRow = {
  id: string;
  evidence_id: string;
  project_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  category: "DOCUMENT" | "VSM";
  version_number: number;
  status: "BROUILLON" | "VALIDE" | "OBSOLETE";
  date_effet: string | null;
  visibility: "PRIVATE" | "INTERNAL";
  created_at: string;
  created_by: number | null;
};

export type CommentRow = {
  id: string;
  work_package_id: string;
  author_id: number;
  author_username: string | null;
  body_markdown: string;
  created_at: string;
  updated_at: string;
};

export type ActivityRow = {
  id: string;
  project_id: string;
  entity_type: string;
  entity_id: string | null;
  action: string;
  actor_id: number;
  actor_username: string | null;
  before_json: unknown;
  after_json: unknown;
  created_at: string;
};

export type ExternalLinkRow = {
  id: string;
  project_id: string;
  entity_type: string;
  entity_id: string | null;
  provider: PoLinkProvider;
  external_type: PoExternalType;
  external_id: string | null;
  url: string;
  status: string | null;
  created_by: number;
  created_at: string;
};

// ---------------------------------------------------------------- Rapport
export type ReportTemplateRow = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  level: "BAC_PLUS_3" | "BAC_PLUS_5" | "INTERNE";
  active: boolean;
};

export type ReportSectionRow = {
  id: string;
  template_id: string;
  parent_id: string | null;
  section_number: string;
  title: string;
  description: string | null;
  expected_content: string | null;
  display_order: number;
};

export type ReportRow = {
  id: string;
  project_id: string;
  template_id: string;
  title: string;
  author_id: number;
  academic_year: string | null;
  status: PoReportStatus;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ReportEntryRow = {
  id: string;
  report_id: string;
  section_id: string;
  status: PoEntryStatus;
  progress_percent: number;
  ai_draft_markdown: string | null;
  validated_markdown: string | null;
  manual_notes: string | null;
  last_generated_at: string | null;
  validated_by: number | null;
  validated_at: string | null;
  updated_at: string;
};

export type ReportAssetRow = {
  id: string;
  project_id: string;
  report_entry_id: string | null;
  title: string;
  description: string | null;
  asset_type: PoAssetType;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  checksum: string | null;
  created_by: number;
  created_at: string;
};

export type WorkLogRow = {
  id: string;
  project_id: string;
  work_package_id: string | null;
  branch_name: string | null;
  pr_url: string | null;
  commit_sha: string | null;
  module: string | null;
  action_type: PoWorkLogAction;
  title: string;
  description: string | null;
  before_state: string | null;
  after_state: string | null;
  created_by: number;
  created_at: string;
};

export type ErrorRecordRow = {
  id: string;
  project_id: string;
  work_package_id: string | null;
  title: string;
  error_message: string | null;
  context: string | null;
  screenshot_asset_id: string | null;
  severity: PoErrorSeverity;
  status: PoErrorStatus;
  fix_summary: string | null;
  fixed_by: number | null;
  fixed_at: string | null;
  created_by: number;
  created_at: string;
};
