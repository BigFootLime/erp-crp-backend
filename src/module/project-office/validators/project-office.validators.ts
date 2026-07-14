import { z } from "zod";

// Validators Zod du module Project Office (#130). Style temps-deplacements : .strict(),
// parse inline dans les contrôleurs, DTOs via z.infer.

export const PO_MEMBER_ROLES = ["OWNER", "MANAGER", "CONTRIBUTOR", "VIEWER"] as const;
export const PO_VISIBILITIES = ["PRIVATE", "INTERNAL", "PILOT"] as const;
export const PO_PROJECT_STATUSES = ["DRAFT", "ACTIVE", "ON_HOLD", "DONE", "ARCHIVED"] as const;
export const PO_WP_TYPES = ["EPIC", "LOT", "FEATURE", "BUG", "AUDIT", "DOC", "INFRA", "SECURITY", "COMPLIANCE", "TASK"] as const;
export const PO_WP_STATUSES = ["BACKLOG", "READY", "IN_PROGRESS", "REVIEW", "BLOCKED", "DONE", "CANCELLED"] as const;
export const PO_PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
export const PO_DEPENDENCY_TYPES = ["BLOCKS", "RELATES", "DUPLICATES", "REQUIRES"] as const;
export const PO_MILESTONE_STATUSES = ["PLANNED", "REACHED", "MISSED", "CANCELLED"] as const;
export const PO_SPEC_STATUSES = ["DRAFT", "REVIEW", "APPROVED", "OBSOLETE"] as const;
export const PO_RISK_STATUSES = ["OPEN", "MITIGATED", "ACCEPTED", "CLOSED"] as const;
export const PO_ACTION_SOURCES = ["AUDIT", "BUG", "RISK", "SECURITY", "USER_FEEDBACK", "OTHER"] as const;
export const PO_ACTION_STATUSES = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export const PO_EVIDENCE_TYPES = ["PR", "COMMIT", "TEST", "SCREENSHOT", "AUDIT", "DEPLOYMENT", "BACKUP", "DOCUMENT", "VSM", "SECURITY_SCAN", "OTHER"] as const;
export const PO_LINK_PROVIDERS = ["GITHUB", "GITLAB", "OTHER"] as const;
export const PO_EXTERNAL_TYPES = ["PR", "ISSUE", "COMMIT", "PIPELINE", "RELEASE", "DOC"] as const;
export const PO_ENTRY_EVIDENCE_RELATIONS = ["SOURCE", "SCREENSHOT", "TEST", "BUG", "FIX", "DECISION", "DEPLOYMENT", "ARCHITECTURE", "UI", "SECURITY"] as const;
export const PO_ASSET_TYPES = ["SCREENSHOT", "ERROR_SCREENSHOT", "UI_SCREENSHOT", "DIAGRAM", "LOG_EXTRACT", "TEST_RESULT", "OTHER"] as const;
export const PO_WORK_LOG_ACTIONS = ["BRANCH_CREATED", "CODE_CHANGE", "BUG_FOUND", "BUG_FIXED", "TEST_RUN", "DEPLOYMENT", "MIGRATION", "REVIEW", "DOCUMENTATION", "SCREENSHOT"] as const;
export const PO_ERROR_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const PO_ERROR_STATUSES = ["OPEN", "FIXED", "WONT_FIX", "DUPLICATE"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD");
const trimmed = (max: number) => z.string().trim().min(1).max(max);
// URLs de preuves/liens : http(s) uniquement (pas de javascript:, file:, etc.).
const httpUrl = z.string().trim().url().max(2048).refine((u) => /^https?:\/\//i.test(u), "URL http(s) requise");

export const uuidParamsSchema = z.object({ id: z.string().uuid() }).strict();
export const projectIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const evidenceFilesQuerySchema = paginationQuerySchema.extend({
  category: z.enum(["DOCUMENT", "VSM"]).optional(),
});

export const projectEvidenceFileContentParamsSchema = z.object({
  projectId: z.string().uuid(),
  id: z.string().uuid(),
}).strict();

export const evidenceFileContentQuerySchema = z.object({
  disposition: z.enum(["inline", "attachment"]).default("attachment"),
}).strict();

// ---------------------------------------------------------------- Projets
export const createProjectSchema = z.object({
  code: trimmed(32).regex(/^[A-Z0-9][A-Z0-9_-]*$/i, "Code alphanumérique (tirets/underscores autorisés)"),
  name: trimmed(200),
  description: z.string().trim().max(10_000).nullish(),
  visibility: z.enum(PO_VISIBILITIES).default("PRIVATE"),
  status: z.enum(PO_PROJECT_STATUSES).default("DRAFT"),
  start_date: isoDate.nullish(),
  target_date: isoDate.nullish(),
}).strict();
export type CreateProjectDTO = z.infer<typeof createProjectSchema>;

export const patchProjectSchema = z.object({
  name: trimmed(200).optional(),
  description: z.string().trim().max(10_000).nullish(),
  visibility: z.enum(PO_VISIBILITIES).optional(),
  status: z.enum(PO_PROJECT_STATUSES).optional(),
  start_date: isoDate.nullish(),
  target_date: isoDate.nullish(),
}).strict();
export type PatchProjectDTO = z.infer<typeof patchProjectSchema>;

export const listProjectsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  status: z.enum(PO_PROJECT_STATUSES).optional(),
}).strict();

export const addMemberSchema = z.object({
  user_id: z.number().int().positive(),
  role: z.enum(PO_MEMBER_ROLES).default("VIEWER"),
}).strict();

export const memberParamsSchema = z.object({
  id: z.string().uuid(),
  userId: z.coerce.number().int().positive(),
}).strict();

// ---------------------------------------------------------------- Work packages
export const createWorkPackageSchema = z.object({
  project_id: z.string().uuid(),
  parent_id: z.string().uuid().nullish(),
  title: trimmed(300),
  description: z.string().trim().max(20_000).nullish(),
  type: z.enum(PO_WP_TYPES).default("TASK"),
  status: z.enum(PO_WP_STATUSES).default("BACKLOG"),
  priority: z.enum(PO_PRIORITIES).default("NORMAL"),
  assignee_id: z.number().int().positive().nullish(),
  start_date: isoDate.nullish(),
  due_date: isoDate.nullish(),
  estimated_hours: z.number().min(0).max(100_000).nullish(),
}).strict();
export type CreateWorkPackageDTO = z.infer<typeof createWorkPackageSchema>;

export const patchWorkPackageSchema = z.object({
  parent_id: z.string().uuid().nullish(),
  title: trimmed(300).optional(),
  description: z.string().trim().max(20_000).nullish(),
  type: z.enum(PO_WP_TYPES).optional(),
  status: z.enum(PO_WP_STATUSES).optional(),
  priority: z.enum(PO_PRIORITIES).optional(),
  assignee_id: z.number().int().positive().nullish(),
  start_date: isoDate.nullish(),
  due_date: isoDate.nullish(),
  progress_percent: z.number().int().min(0).max(100).optional(),
  estimated_hours: z.number().min(0).max(100_000).nullish(),
  spent_hours: z.number().min(0).max(100_000).nullish(),
}).strict();
export type PatchWorkPackageDTO = z.infer<typeof patchWorkPackageSchema>;

export const listWorkPackagesQuerySchema = paginationQuerySchema.extend({
  project_id: z.string().uuid(),
  q: z.string().trim().max(200).optional(),
  status: z.enum(PO_WP_STATUSES).optional(),
  type: z.enum(PO_WP_TYPES).optional(),
  assignee_id: z.coerce.number().int().positive().optional(),
  parent_id: z.string().uuid().optional(),
}).strict();

export const createCommentSchema = z.object({
  body_markdown: trimmed(20_000),
}).strict();

export const createDependencySchema = z.object({
  target_work_package_id: z.string().uuid(),
  dependency_type: z.enum(PO_DEPENDENCY_TYPES).default("BLOCKS"),
}).strict();

export const createMilestoneSchema = z.object({
  name: trimmed(200),
  description: z.string().trim().max(5_000).nullish(),
  due_date: isoDate.nullish(),
}).strict();

export const patchMilestoneSchema = z.object({
  name: trimmed(200).optional(),
  description: z.string().trim().max(5_000).nullish(),
  due_date: isoDate.nullish(),
  status: z.enum(PO_MILESTONE_STATUSES).optional(),
}).strict();

// ---------------------------------------------------------------- Cahier des charges
export const createSpecSchema = z.object({
  title: trimmed(300),
  content_markdown: z.string().trim().max(500_000).optional(), // crée la v1 si fourni
}).strict();

export const createSpecVersionSchema = z.object({
  version: trimmed(50).regex(/^[0-9A-Za-z._-]+$/, "Version alphanumérique (ex. 1.0, 2.1-rc1)"),
  content_markdown: z.string().trim().min(1).max(500_000),
  change_summary: z.string().trim().max(5_000).nullish(),
}).strict();

export const patchSpecStatusSchema = z.object({
  status: z.enum(["DRAFT", "REVIEW", "OBSOLETE"]), // APPROVED uniquement via /approve
}).strict();

// ---------------------------------------------------------------- Registres
export const createDecisionSchema = z.object({
  title: trimmed(300),
  context: z.string().trim().max(20_000).nullish(),
  options_json: z.array(z.object({ option: trimmed(500), pros: z.string().max(2_000).optional(), cons: z.string().max(2_000).optional() }).strict()).max(20).nullish(),
  decision: trimmed(20_000),
  consequences: z.string().trim().max(20_000).nullish(),
}).strict();

export const createRiskSchema = z.object({
  title: trimmed(300),
  description: z.string().trim().max(20_000).nullish(),
  probability: z.number().int().min(1).max(5),
  impact: z.number().int().min(1).max(5),
  mitigation: z.string().trim().max(20_000).nullish(),
  owner_id: z.number().int().positive().nullish(),
}).strict();

export const patchRiskSchema = z.object({
  title: trimmed(300).optional(),
  description: z.string().trim().max(20_000).nullish(),
  probability: z.number().int().min(1).max(5).optional(),
  impact: z.number().int().min(1).max(5).optional(),
  mitigation: z.string().trim().max(20_000).nullish(),
  owner_id: z.number().int().positive().nullish(),
  status: z.enum(PO_RISK_STATUSES).optional(),
}).strict();

export const createActionSchema = z.object({
  source_type: z.enum(PO_ACTION_SOURCES).default("OTHER"),
  title: trimmed(300),
  description: z.string().trim().max(20_000).nullish(),
  priority: z.enum(PO_PRIORITIES).default("NORMAL"),
  owner_id: z.number().int().positive().nullish(),
  due_date: isoDate.nullish(),
  evidence_id: z.string().uuid().nullish(),
}).strict();

export const patchActionSchema = z.object({
  source_type: z.enum(PO_ACTION_SOURCES).optional(),
  title: trimmed(300).optional(),
  description: z.string().trim().max(20_000).nullish(),
  priority: z.enum(PO_PRIORITIES).optional(),
  owner_id: z.number().int().positive().nullish(),
  due_date: isoDate.nullish(),
  status: z.enum(PO_ACTION_STATUSES).optional(),
  evidence_id: z.string().uuid().nullish(),
}).strict();

export const createEvidenceSchema = z.object({
  work_package_id: z.string().uuid().nullish(),
  type: z.enum(PO_EVIDENCE_TYPES).default("OTHER"),
  title: trimmed(300),
  url: httpUrl.nullish(),
  description: z.string().trim().max(10_000).nullish(),
}).strict();

// Multipart metadata for a controlled evidence file.  The binary itself is
// accepted only by the dedicated upload route, never by a JSON evidence URL.
export const createEvidenceFileSchema = z.object({
  work_package_id: z.string().uuid().nullish(),
  title: trimmed(300).optional(),
  description: z.string().trim().max(10_000).nullish(),
  category: z.enum(["DOCUMENT", "VSM"]).default("DOCUMENT"),
  version_number: z.coerce.number().int().positive().default(1),
  status: z.enum(["BROUILLON", "VALIDE", "OBSOLETE"]).default("BROUILLON"),
  date_effet: isoDate.nullish(),
  visibility: z.enum(["PRIVATE", "INTERNAL"]).default("INTERNAL"),
}).strict();
export type CreateEvidenceFileDTO = z.infer<typeof createEvidenceFileSchema>;

export const createExternalLinkSchema = z.object({
  project_id: z.string().uuid(),
  entity_type: z.enum(["project", "work_package", "spec", "decision", "risk", "action"]).default("project"),
  entity_id: z.string().uuid().nullish(),
  provider: z.enum(PO_LINK_PROVIDERS).default("GITHUB"),
  external_type: z.enum(PO_EXTERNAL_TYPES).default("PR"),
  external_id: z.string().trim().max(200).nullish(),
  url: httpUrl,
  status: z.string().trim().max(100).nullish(),
}).strict();

// ---------------------------------------------------------------- Rapport Bac+5
export const createReportSchema = z.object({
  template_code: z.string().trim().max(100).default("RAPPORT_BAC5_CERP"),
  title: trimmed(300),
  academic_year: z.string().trim().max(20).nullish(),
}).strict();

export const entryParamsSchema = z.object({
  id: z.string().uuid(),        // report id
  sectionId: z.string().uuid(), // section id
}).strict();

export const patchEntrySchema = z.object({
  validated_markdown: z.string().trim().max(500_000).nullish(),
  manual_notes: z.string().trim().max(50_000).nullish(),
  status: z.enum(["A_DOCUMENTER", "A_RELIRE", "A_RETRAVAILLER"]).optional(), // VALIDE via /validate, BROUILLON_IA via /generate
}).strict();

export const linkEntryEvidenceSchema = z.object({
  evidence_id: z.string().uuid(),
  relation_type: z.enum(PO_ENTRY_EVIDENCE_RELATIONS).default("SOURCE"),
}).strict();

export const createReportVersionSchema = z.object({
  version: trimmed(50).regex(/^[0-9A-Za-z._-]+$/),
  title: trimmed(300).optional(),
}).strict();

export const createWorkLogSchema = z.object({
  work_package_id: z.string().uuid().nullish(),
  branch_name: z.string().trim().max(300).nullish(),
  pr_url: httpUrl.nullish(),
  commit_sha: z.string().trim().regex(/^[0-9a-f]{7,64}$/i).nullish(),
  module: z.string().trim().max(100).nullish(),
  action_type: z.enum(PO_WORK_LOG_ACTIONS).default("CODE_CHANGE"),
  title: trimmed(300),
  description: z.string().trim().max(20_000).nullish(),
  before_state: z.string().trim().max(20_000).nullish(),
  after_state: z.string().trim().max(20_000).nullish(),
}).strict();

export const listWorkLogsQuerySchema = paginationQuerySchema.extend({
  action_type: z.enum(PO_WORK_LOG_ACTIONS).optional(),
}).strict();

export const createErrorRecordSchema = z.object({
  work_package_id: z.string().uuid().nullish(),
  title: trimmed(300),
  error_message: z.string().trim().max(20_000).nullish(),
  context: z.string().trim().max(20_000).nullish(),
  screenshot_asset_id: z.string().uuid().nullish(),
  severity: z.enum(PO_ERROR_SEVERITIES).default("MEDIUM"),
}).strict();

export const patchErrorRecordSchema = z.object({
  title: trimmed(300).optional(),
  error_message: z.string().trim().max(20_000).nullish(),
  context: z.string().trim().max(20_000).nullish(),
  screenshot_asset_id: z.string().uuid().nullish(),
  severity: z.enum(PO_ERROR_SEVERITIES).optional(),
  status: z.enum(PO_ERROR_STATUSES).optional(),
  fix_summary: z.string().trim().max(20_000).nullish(),
}).strict();

export const createAssetSchema = z.object({
  report_entry_id: z.string().uuid().nullish(),
  title: trimmed(300),
  description: z.string().trim().max(5_000).nullish(),
  asset_type: z.enum(PO_ASSET_TYPES).default("SCREENSHOT"),
}).strict();
