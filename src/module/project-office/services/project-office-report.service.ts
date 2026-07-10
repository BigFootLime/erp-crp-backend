import crypto from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import {
  insertAuditLog,
  insertProjectActivity,
  isPgUniqueViolation,
  repoGetProjectById,
  withTransaction,
  type AuditContext,
} from "../repository/project-office.repository";
import {
  repoCountEntryEvidenceForReport,
  repoCreateAsset,
  repoCreateErrorRecord,
  repoCreateReport,
  repoCreateReportExport,
  repoCreateReportVersion,
  repoCreateWorkLog,
  repoGetAssetById,
  repoGetEntry,
  repoGetEntryProjectId,
  repoGetErrorById,
  repoGetReportById,
  repoGetReportExportById,
  repoGetSectionById,
  repoGetTemplateByCode,
  repoInitReportEntries,
  repoInsertGenerationRun,
  repoLinkEntryEvidence,
  repoListAssets,
  repoListEntries,
  repoListEntryEvidence,
  repoListErrorRecords,
  repoListReportExports,
  repoListReports,
  repoListReportVersions,
  repoListSections,
  repoListTemplates,
  repoListWorkLogs,
  repoPatchEntry,
  repoPatchErrorRecord,
  repoSetReportStatus,
} from "../repository/project-office-report.repository";
import { repoGetEvidenceById } from "../repository/project-office-registers.repository";
import { repoGetWorkPackageById } from "../repository/project-office-work.repository";
import type {
  Actor,
  PoEntryStatus,
  PoEvidenceType,
  PoWorkLogAction,
  ReportEntryRow,
  ReportRow,
  ReportSectionRow,
} from "../types/project-office.types";
import { requireProjectAccess } from "./project-office-access.service";
import { buildReportDocx, type DocxReportInput, type DocxSectionInput } from "./project-office-docx.service";

// ------------------------------------------------------------------ Suggestions preuves → sections
// Mapping déterministe utilisé par la génération ET exposé comme aide au classement.
export function suggestSectionsForWorkLog(action: PoWorkLogAction): string[] {
  const map: Record<PoWorkLogAction, string[]> = {
    BRANCH_CREATED: ["9.3"],
    CODE_CHANGE: ["10.1", "10.3"],
    BUG_FOUND: ["12.3"],
    BUG_FIXED: ["12.3", "11.3"],
    TEST_RUN: ["12.1", "10.4"],
    DEPLOYMENT: ["14.3", "15.1", "15.2"],
    MIGRATION: ["7.3", "9.4"],
    REVIEW: ["12.4", "10.2"],
    DOCUMENTATION: ["16.1", "16.2"],
    SCREENSHOT: ["6.3", "15.4"],
  };
  return map[action] ?? [];
}

export function suggestSectionsForEvidenceType(type: PoEvidenceType): string[] {
  const map: Record<PoEvidenceType, string[]> = {
    PR: ["10.1"],
    COMMIT: ["10.1"],
    TEST: ["12.1"],
    SCREENSHOT: ["6.3", "15.4"],
    AUDIT: ["12.4"],
    DEPLOYMENT: ["15.1"],
    BACKUP: ["14.2"],
    DOCUMENT: ["16.1"],
    SECURITY_SCAN: ["11.4"],
    OTHER: [],
  };
  return map[type] ?? [];
}

// Progression d'une entrée : 0 vide · 25 preuves sans texte · 50 brouillon IA · 75 relu · 100 validé.
export function computeEntryProgress(entry: Pick<ReportEntryRow, "status" | "ai_draft_markdown" | "validated_markdown">, evidenceCount: number): number {
  if (entry.status === "VALIDE" || entry.status === "EXPORTE") return 100;
  if (entry.status === "A_RELIRE") return 75;
  if (entry.validated_markdown && entry.validated_markdown.trim()) return 75;
  if (entry.status === "BROUILLON_IA" && entry.ai_draft_markdown) return 50;
  if (evidenceCount > 0) return 25;
  return 0;
}

// ------------------------------------------------------------------ Rapports
export async function listTemplates() {
  return repoListTemplates();
}

export async function listReports(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListReports(projectId);
}

export async function createReport(
  actor: Actor,
  projectId: string,
  input: { template_code: string; title: string; academic_year?: string | null },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  const template = await repoGetTemplateByCode(input.template_code);
  if (!template) throw new HttpError(404, "PO_TEMPLATE_NOT_FOUND", "Modèle de rapport introuvable (seed manquant ?).");
  return withTransaction(async (tx) => {
    const report = await repoCreateReport(tx, {
      project_id: projectId, template_id: template.id, title: input.title,
      author_id: actor.id, academic_year: input.academic_year ?? null,
    });
    const entries = await repoInitReportEntries(tx, report.id, template.id);
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "report", entity_id: report.id, action: "create",
      actor_id: actor.id, after_json: { title: report.title, template: template.code, entries },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.report.create", entity_type: "project_reports", entity_id: report.id,
      details: { project_id: projectId, template: template.code, entries },
    });
    return { report, entries_created: entries };
  });
}

export async function requireReport(actor: Actor, reportId: string, need: "read" | "write" = "read"): Promise<ReportRow> {
  const report = await repoGetReportById(reportId);
  if (!report) throw new HttpError(404, "PO_REPORT_NOT_FOUND", "Rapport introuvable.");
  await requireProjectAccess(actor, report.project_id, need);
  return report;
}

export type ReportPlanSection = ReportSectionRow & {
  entry: ReportEntryRow | null;
  evidence_count: number;
  children: ReportPlanSection[];
};

export async function getReportDetail(actor: Actor, reportId: string) {
  const report = await requireReport(actor, reportId, "read");
  const [sections, entries, evidenceCounts, versions, exports] = await Promise.all([
    repoListSections(report.template_id),
    repoListEntries(reportId),
    repoCountEntryEvidenceForReport(reportId),
    repoListReportVersions(reportId),
    repoListReportExports(reportId),
  ]);
  const entriesBySection = new Map(entries.map((e) => [e.section_id, e]));
  const roots: ReportPlanSection[] = [];
  const byId = new Map<string, ReportPlanSection>();
  for (const s of sections) {
    const entry = entriesBySection.get(s.id) ?? null;
    const node: ReportPlanSection = {
      ...s,
      entry,
      evidence_count: entry ? evidenceCounts.get(entry.id) ?? 0 : 0,
      children: [],
    };
    byId.set(s.id, node);
    if (!s.parent_id) roots.push(node);
  }
  for (const s of sections) {
    if (s.parent_id) byId.get(s.parent_id)?.children.push(byId.get(s.id)!);
  }
  // Progression globale = moyenne des sous-parties (sections feuilles).
  const leaves = sections.filter((s) => s.parent_id !== null);
  const progress = leaves.length
    ? Math.round(
        leaves.reduce((sum, s) => {
          const e = entriesBySection.get(s.id);
          return sum + (e ? computeEntryProgress(e, evidenceCounts.get(e.id) ?? 0) : 0);
        }, 0) / leaves.length
      )
    : 0;
  return { report, progress, plan: roots, versions, exports };
}

export async function getEntryDetail(actor: Actor, reportId: string, sectionId: string) {
  const report = await requireReport(actor, reportId, "read");
  const section = await repoGetSectionById(sectionId);
  if (!section || section.template_id !== report.template_id) {
    throw new HttpError(404, "PO_SECTION_NOT_FOUND", "Section introuvable pour ce rapport.");
  }
  const entry = await repoGetEntry(reportId, sectionId);
  if (!entry) throw new HttpError(404, "PO_ENTRY_NOT_FOUND", "Entrée de rapport introuvable.");
  const [evidence, assets] = await Promise.all([
    repoListEntryEvidence(entry.id),
    repoListAssets({ project_id: report.project_id, report_entry_id: entry.id }),
  ]);
  return { section, entry, evidence, assets };
}

export async function patchEntry(
  actor: Actor,
  reportId: string,
  sectionId: string,
  patch: { validated_markdown?: string | null; manual_notes?: string | null; status?: PoEntryStatus },
  audit: AuditContext
) {
  const report = await requireReport(actor, reportId, "write");
  const entry = await repoGetEntry(reportId, sectionId);
  if (!entry) throw new HttpError(404, "PO_ENTRY_NOT_FOUND", "Entrée de rapport introuvable.");
  const evidenceCount = (await repoListEntryEvidence(entry.id)).length;
  const effective: Record<string, unknown> = { ...patch };
  const next = { ...entry, ...patch } as ReportEntryRow;
  effective.progress_percent = computeEntryProgress(next, evidenceCount);
  return withTransaction(async (tx) => {
    const updated = await repoPatchEntry(tx, reportId, sectionId, effective);
    if (!updated) throw new HttpError(404, "PO_ENTRY_NOT_FOUND", "Entrée de rapport introuvable.");
    if (report.status === "DRAFT") await repoSetReportStatus(tx, reportId, "IN_PROGRESS");
    await insertProjectActivity(tx, {
      project_id: report.project_id, entity_type: "report_entry", entity_id: updated.id, action: "update",
      actor_id: actor.id, after_json: { section_id: sectionId, fields: Object.keys(patch) },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.report.entry.update", entity_type: "project_report_entries", entity_id: updated.id,
      details: { report_id: reportId, fields: Object.keys(patch) },
    });
    return updated;
  });
}

export async function validateEntry(actor: Actor, reportId: string, sectionId: string, audit: AuditContext) {
  const report = await requireReport(actor, reportId, "write");
  const entry = await repoGetEntry(reportId, sectionId);
  if (!entry) throw new HttpError(404, "PO_ENTRY_NOT_FOUND", "Entrée de rapport introuvable.");
  const content = entry.validated_markdown?.trim() || entry.ai_draft_markdown?.trim();
  if (!content) throw new HttpError(409, "PO_ENTRY_EMPTY", "Impossible de valider une section sans contenu.");
  return withTransaction(async (tx) => {
    const updated = await repoPatchEntry(tx, reportId, sectionId, {
      status: "VALIDE",
      progress_percent: 100,
      // Si l'utilisateur n'a pas édité, le brouillon relu devient le texte validé (traçé).
      validated_markdown: entry.validated_markdown?.trim() ? entry.validated_markdown : entry.ai_draft_markdown,
      validated_by: actor.id,
      validated_at: new Date().toISOString(),
    });
    if (!updated) throw new HttpError(404, "PO_ENTRY_NOT_FOUND", "Entrée introuvable.");
    await insertProjectActivity(tx, {
      project_id: report.project_id, entity_type: "report_entry", entity_id: updated.id, action: "validate",
      actor_id: actor.id, after_json: { section_id: sectionId },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.report.entry.validate", entity_type: "project_report_entries", entity_id: updated.id,
      details: { report_id: reportId, section_id: sectionId },
    });
    return updated;
  });
}

export async function linkEntryEvidence(
  actor: Actor,
  reportId: string,
  sectionId: string,
  input: { evidence_id: string; relation_type: string },
  audit: AuditContext
) {
  const report = await requireReport(actor, reportId, "write");
  const entry = await repoGetEntry(reportId, sectionId);
  if (!entry) throw new HttpError(404, "PO_ENTRY_NOT_FOUND", "Entrée de rapport introuvable.");
  const evidence = await repoGetEvidenceById(input.evidence_id);
  if (!evidence || evidence.project_id !== report.project_id) {
    throw new HttpError(400, "PO_EVIDENCE_BAD_PROJECT", "Preuve invalide pour ce projet.");
  }
  await withTransaction(async (tx) => {
    await repoLinkEntryEvidence(tx, { report_entry_id: entry.id, evidence_id: input.evidence_id, relation_type: input.relation_type });
    const count = (await repoListEntryEvidence(entry.id, tx)).length;
    await repoPatchEntry(tx, reportId, sectionId, {
      progress_percent: computeEntryProgress(entry, count),
      status: entry.status === "VIDE" ? "A_DOCUMENTER" : entry.status,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.report.entry.link-evidence", entity_type: "project_report_entries", entity_id: entry.id,
      details: { report_id: reportId, evidence_id: input.evidence_id, relation: input.relation_type },
    });
  });
  return { linked: true };
}

// ------------------------------------------------------------------ Génération evidence-based
// RÈGLE ANTI-BLABLA : chaque ligne provient d'un enregistrement réel (preuve, journal, erreur,
// capture). Sans matière : « À compléter » — on n'invente JAMAIS.
const NO_EVIDENCE_TEXT =
  "Cette section nécessite encore des éléments de preuve.\n\nÀ compléter manuellement, ou lier des preuves (tâches, PR, tests, captures) puis régénérer.";

type SectionMaterials = {
  evidence: { type: string; title: string; url: string | null; description: string | null; relation_type: string }[];
  workLogs: { action_type: string; title: string; description: string | null; branch_name: string | null; pr_url: string | null; commit_sha: string | null; created_at: string }[];
  errors: { title: string; error_message: string | null; status: string; fix_summary: string | null; severity: string; created_at: string; fixed_at: string | null }[];
  assets: { title: string; description: string | null }[];
};

export function buildDeterministicDraft(
  section: Pick<ReportSectionRow, "section_number" | "title" | "description">,
  m: SectionMaterials
): { markdown: string; hasMaterial: boolean } {
  const total = m.evidence.length + m.workLogs.length + m.errors.length + m.assets.length;
  if (total === 0) return { markdown: NO_EVIDENCE_TEXT, hasMaterial: false };
  const l: string[] = [];
  if (section.description) l.push(`${section.description}`, "");
  if (m.workLogs.length) {
    l.push(`### Travaux réalisés`, "");
    for (const w of m.workLogs) {
      const refs: string[] = [];
      if (w.branch_name) refs.push(`branche \`${w.branch_name}\``);
      if (w.commit_sha) refs.push(`commit \`${w.commit_sha.slice(0, 10)}\``);
      if (w.pr_url) refs.push(`PR ${w.pr_url}`);
      l.push(`- ${w.created_at.slice(0, 10)} — **${w.title}**${w.description ? ` : ${w.description}` : ""}${refs.length ? ` (${refs.join(", ")})` : ""}`);
    }
    l.push("");
  }
  if (m.errors.length) {
    l.push(`### Erreurs rencontrées et corrections`, "");
    for (const e of m.errors) {
      if (e.status === "FIXED" && e.fix_summary) {
        l.push(`- **${e.title}** (sévérité ${e.severity}) — détectée le ${e.created_at.slice(0, 10)}${e.error_message ? ` : ${e.error_message}` : ""}. Correction (${e.fixed_at ? e.fixed_at.slice(0, 10) : "date n/d"}) : ${e.fix_summary}.`);
      } else {
        l.push(`- **${e.title}** (sévérité ${e.severity}, ${e.status}) — ${e.error_message ?? "détail à documenter"}.`);
      }
    }
    l.push("");
  }
  if (m.evidence.length) {
    l.push(`### Preuves`, "");
    for (const ev of m.evidence) {
      l.push(`- [${ev.type}] **${ev.title}**${ev.description ? ` — ${ev.description}` : ""}${ev.url ? ` — ${ev.url}` : ""}`);
    }
    l.push("");
  }
  if (m.assets.length) {
    l.push(`### Captures associées`, "");
    for (const a of m.assets) l.push(`- ${a.title}${a.description ? ` — ${a.description}` : ""} *(intégrée à l'export)*`);
    l.push("");
  }
  l.push("---");
  l.push(
    `_Brouillon généré automatiquement à partir de ${m.evidence.length} preuve(s), ${m.workLogs.length} entrée(s) de journal, ${m.errors.length} erreur(s), ${m.assets.length} capture(s). Chaque élément ci-dessus provient d'un enregistrement réel du module — à relire, compléter et valider._`
  );
  return { markdown: l.join("\n"), hasMaterial: true };
}

async function gatherMaterials(report: ReportRow, section: ReportSectionRow, entryId: string): Promise<SectionMaterials> {
  const [linkedEvidence, workLogsAll, errorsAll, assets] = await Promise.all([
    repoListEntryEvidence(entryId),
    repoListWorkLogs({ project_id: report.project_id, page: 1, pageSize: 200 }),
    repoListErrorRecords(report.project_id),
    repoListAssets({ project_id: report.project_id, report_entry_id: entryId }),
  ]);
  const num = section.section_number;
  const workLogs = workLogsAll.items.filter((w) => suggestSectionsForWorkLog(w.action_type).includes(num));
  const errorSections = new Set(["11.3", "12.3", "13.1"]);
  const errors = errorSections.has(num) ? errorsAll : [];
  return {
    evidence: linkedEvidence.map((e) => ({ type: e.type, title: e.title, url: e.url, description: e.description, relation_type: e.relation_type })),
    workLogs: workLogs.map((w) => ({
      action_type: w.action_type, title: w.title, description: w.description,
      branch_name: w.branch_name, pr_url: w.pr_url, commit_sha: w.commit_sha, created_at: w.created_at,
    })),
    errors: errors.map((e) => ({
      title: e.title, error_message: e.error_message, status: e.status, fix_summary: e.fix_summary,
      severity: e.severity, created_at: e.created_at, fixed_at: e.fixed_at,
    })),
    assets: assets.map((a) => ({ title: a.title, description: a.description })),
  };
}

export async function generateEntryDraft(
  actor: Actor,
  reportId: string,
  sectionId: string,
  mode: "AUTO_FROM_EVIDENCE" | "MANUAL_REGENERATE",
  audit: AuditContext
) {
  const report = await requireReport(actor, reportId, "write");
  const section = await repoGetSectionById(sectionId);
  if (!section || section.template_id !== report.template_id) {
    throw new HttpError(404, "PO_SECTION_NOT_FOUND", "Section introuvable pour ce rapport.");
  }
  const entry = await repoGetEntry(reportId, sectionId);
  if (!entry) throw new HttpError(404, "PO_ENTRY_NOT_FOUND", "Entrée de rapport introuvable.");

  let materials: SectionMaterials;
  if (section.parent_id === null) {
    // Section chapitre : sommaire déterministe des sous-parties (pas de contenu inventé).
    materials = { evidence: [], workLogs: [], errors: [], assets: [] };
    const sections = await repoListSections(report.template_id);
    const entries = await repoListEntries(reportId);
    const entryBySection = new Map(entries.map((e) => [e.section_id, e]));
    const children = sections.filter((s) => s.parent_id === sectionId);
    const lines = children.map((c) => {
      const e = entryBySection.get(c.id);
      return `- **${c.section_number} ${c.title}** — ${e ? e.status.replace(/_/g, " ") : "VIDE"}`;
    });
    const markdown = children.length
      ? `${section.description ?? ""}\n\n### État des sous-parties\n\n${lines.join("\n")}\n\n---\n_Chapitre de synthèse généré automatiquement : le contenu détaillé vit dans les sous-parties._`
      : NO_EVIDENCE_TEXT;
    return persistDraft(actor, report, section, entry, markdown, children.length > 0, mode, audit);
  }
  materials = await gatherMaterials(report, section, entry.id);
  const { markdown, hasMaterial } = buildDeterministicDraft(section, materials);
  return persistDraft(actor, report, section, entry, markdown, hasMaterial, mode, audit, {
    evidence: materials.evidence.length,
    work_logs: materials.workLogs.length,
    errors: materials.errors.length,
    assets: materials.assets.length,
  });
}

async function persistDraft(
  actor: Actor,
  report: ReportRow,
  section: ReportSectionRow,
  entry: ReportEntryRow,
  markdown: string,
  hasMaterial: boolean,
  mode: "AUTO_FROM_EVIDENCE" | "MANUAL_REGENERATE",
  audit: AuditContext,
  counts?: Record<string, number>
) {
  const evidenceCount = counts?.evidence ?? 0;
  return withTransaction(async (tx) => {
    // Jamais d'écrasement du texte validé : le brouillon vit dans ai_draft_markdown.
    const nextStatus: PoEntryStatus =
      entry.status === "VALIDE" || entry.status === "EXPORTE"
        ? entry.status
        : hasMaterial
          ? "BROUILLON_IA"
          : "A_DOCUMENTER";
    const updated = await repoPatchEntry(tx, report.id, section.id, {
      ai_draft_markdown: markdown,
      status: nextStatus,
      last_generated_at: new Date().toISOString(),
      progress_percent: computeEntryProgress(
        { status: nextStatus, ai_draft_markdown: hasMaterial ? markdown : null, validated_markdown: entry.validated_markdown },
        evidenceCount
      ),
    });
    if (!updated) throw new HttpError(404, "PO_ENTRY_NOT_FOUND", "Entrée introuvable.");
    if (report.status === "DRAFT") await repoSetReportStatus(tx, report.id, "IN_PROGRESS");
    await repoInsertGenerationRun(tx, {
      report_id: report.id, section_id: section.id, triggered_by: actor.id, mode,
      input_context_json: counts ?? {},
      output_summary: hasMaterial ? `Brouillon généré (${markdown.length} caractères)` : "Matière insuffisante — À compléter",
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.report.entry.generate", entity_type: "project_report_entries", entity_id: updated.id,
      details: { report_id: report.id, section: section.section_number, mode, has_material: hasMaterial },
    });
    return updated;
  });
}

export async function generateFullReport(actor: Actor, reportId: string, audit: AuditContext) {
  const report = await requireReport(actor, reportId, "write");
  const sections = await repoListSections(report.template_id);
  let generated = 0;
  let skippedValidated = 0;
  // Sous-parties d'abord, chapitres ensuite (le sommaire de chapitre reflète l'état frais).
  const ordered = [...sections.filter((s) => s.parent_id !== null), ...sections.filter((s) => s.parent_id === null)];
  for (const section of ordered) {
    const entry = await repoGetEntry(reportId, section.id);
    if (!entry) continue;
    if (entry.status === "VALIDE" || entry.status === "EXPORTE") { skippedValidated++; continue; }
    await generateEntryDraft(actor, reportId, section.id, "AUTO_FROM_EVIDENCE", audit);
    generated++;
  }
  await withTransaction(async (tx) => {
    await repoInsertGenerationRun(tx, {
      report_id: reportId, section_id: null, triggered_by: actor.id, mode: "FULL_REPORT",
      input_context_json: { generated, skipped_validated: skippedValidated },
      output_summary: `Génération complète : ${generated} section(s), ${skippedValidated} validée(s) préservée(s)`,
    });
  });
  return { generated, skipped_validated: skippedValidated };
}

// ------------------------------------------------------------------ Versions & exports
export async function createReportVersion(
  actor: Actor,
  reportId: string,
  input: { version: string; title?: string },
  audit: AuditContext
) {
  const report = await requireReport(actor, reportId, "write");
  const detail = await getReportDetail(actor, reportId);
  const markdown = assembleReportMarkdown(detail.report, detail.plan);
  try {
    return await withTransaction(async (tx) => {
      const version = await repoCreateReportVersion(tx, {
        report_id: reportId,
        version: input.version,
        title: input.title ?? `${report.title} — v${input.version}`,
        snapshot_json: {
          progress: detail.progress,
          sections: flattenPlan(detail.plan).map((s) => ({
            section_number: s.section_number,
            status: s.entry?.status ?? "VIDE",
            progress: s.entry?.progress_percent ?? 0,
            validated_markdown: s.entry?.validated_markdown ?? null,
            ai_draft_markdown: s.entry?.ai_draft_markdown ?? null,
          })),
        },
        generated_markdown: markdown,
        created_by: actor.id,
      });
      await insertProjectActivity(tx, {
        project_id: report.project_id, entity_type: "report", entity_id: reportId, action: "version",
        actor_id: actor.id, after_json: { version: input.version },
      });
      await insertAuditLog(tx, audit, {
        action: "project-office.report.version.create", entity_type: "project_report_versions", entity_id: version.id,
        details: { report_id: reportId, version: input.version },
      });
      return version;
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) throw new HttpError(409, "PO_REPORT_VERSION_TAKEN", "Cette version du rapport existe déjà.");
    throw err;
  }
}

function flattenPlan(plan: ReportPlanSection[]): ReportPlanSection[] {
  const out: ReportPlanSection[] = [];
  for (const root of plan) {
    out.push(root);
    out.push(...root.children);
  }
  return out;
}

export function assembleReportMarkdown(report: ReportRow, plan: ReportPlanSection[]): string {
  const l: string[] = [`# ${report.title}`, ""];
  for (const s of flattenPlan(plan)) {
    l.push(`${s.parent_id ? "##" : "#"} ${s.section_number}. ${s.title}`, "");
    const content = s.entry?.validated_markdown?.trim() || s.entry?.ai_draft_markdown?.trim();
    if (content) {
      if (!s.entry?.validated_markdown?.trim()) l.push(`> Brouillon IA à valider`, "");
      l.push(content, "");
    } else {
      l.push(`_À compléter._`, "");
    }
  }
  return l.join("\n");
}

async function buildDocxInput(actor: Actor, reportId: string, onlySectionId?: string): Promise<{ report: ReportRow; input: DocxReportInput }> {
  const report = await requireReport(actor, reportId, "read");
  const detail = await getReportDetail(actor, reportId);
  const project = await repoGetProjectById(report.project_id);
  const versions = await repoListReportVersions(reportId);
  const all = flattenPlan(detail.plan).filter((s) => {
    if (!onlySectionId) return true;
    return s.id === onlySectionId || s.parent_id === onlySectionId;
  });
  if (onlySectionId && all.length === 0) throw new HttpError(404, "PO_SECTION_NOT_FOUND", "Section introuvable pour ce rapport.");
  const sections: DocxSectionInput[] = [];
  for (const s of all) {
    const entry = s.entry;
    const [evidence, assets] = entry
      ? await Promise.all([
          repoListEntryEvidence(entry.id),
          repoListAssets({ project_id: report.project_id, report_entry_id: entry.id }),
        ])
      : [[], []];
    const assetsWithContent = [];
    for (const a of assets) {
      const full = await repoGetAssetById(a.id);
      assetsWithContent.push({
        title: a.title, description: a.description, mime_type: a.mime_type,
        content_base64: full?.content_base64 ?? null,
      });
    }
    sections.push({
      section_number: s.section_number,
      title: s.title,
      description: s.description,
      depth: s.parent_id ? 1 : 0,
      status: entry?.status ?? "VIDE",
      markdown: entry?.validated_markdown?.trim() || entry?.ai_draft_markdown?.trim() || null,
      is_validated: entry?.status === "VALIDE" || entry?.status === "EXPORTE",
      evidence: evidence.map((e) => ({ type: e.type, title: e.title, url: e.url })),
      assets: assetsWithContent,
    });
  }
  const currentVersion = versions[0]?.version ?? "draft";
  return {
    report,
    input: {
      title: report.title,
      project_name: project?.name ?? report.project_id,
      project_code: project?.code ?? "",
      author_name: `Utilisateur #${report.author_id}`,
      academic_year: report.academic_year,
      version: currentVersion,
      confidential: true,
      sections,
      versions_history: versions.map((v) => ({ version: v.version, title: v.title, created_at: v.created_at })),
    },
  };
}

export async function exportReportDocx(
  actor: Actor,
  reportId: string,
  opts: { sectionId?: string },
  audit: AuditContext
): Promise<{ filename: string; buffer: Buffer; checksum: string }> {
  const { report, input } = await buildDocxInput(actor, reportId, opts.sectionId);
  // Auteur lisible si disponible.
  const buffer = await buildReportDocx(input);
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const filename = opts.sectionId
    ? `rapport-projet-cerp-section-${input.sections[0]?.section_number ?? "x"}-v${input.version}.docx`
    : `rapport-projet-cerp-v${input.version}.docx`;
  await withTransaction(async (tx) => {
    const exportRow = await repoCreateReportExport(tx, {
      report_id: reportId,
      version_id: report.current_version_id,
      export_type: opts.sectionId ? "SECTION_DOCX" : "FULL_DOCX",
      section_id: opts.sectionId ?? null,
      file_path: filename,
      checksum,
      file_base64: buffer.toString("base64"),
      exported_by: actor.id,
    });
    await insertProjectActivity(tx, {
      project_id: report.project_id, entity_type: "report", entity_id: reportId, action: "export",
      actor_id: actor.id, after_json: { export_id: exportRow.id, type: opts.sectionId ? "SECTION_DOCX" : "FULL_DOCX", checksum },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.report.export", entity_type: "project_report_exports", entity_id: exportRow.id,
      details: { report_id: reportId, export_type: opts.sectionId ? "SECTION_DOCX" : "FULL_DOCX", checksum },
    });
  });
  return { filename, buffer, checksum };
}

export async function exportReportMarkdown(actor: Actor, reportId: string, audit: AuditContext) {
  const report = await requireReport(actor, reportId, "read");
  const detail = await getReportDetail(actor, reportId);
  const markdown = assembleReportMarkdown(report, detail.plan);
  const checksum = crypto.createHash("sha256").update(markdown, "utf8").digest("hex");
  const filename = `rapport-projet-cerp-${report.id.slice(0, 8)}.md`;
  await withTransaction(async (tx) => {
    const exportRow = await repoCreateReportExport(tx, {
      report_id: reportId, version_id: report.current_version_id, export_type: "MARKDOWN",
      section_id: null, file_path: filename, checksum,
      file_base64: Buffer.from(markdown, "utf8").toString("base64"), exported_by: actor.id,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.report.export", entity_type: "project_report_exports", entity_id: exportRow.id,
      details: { report_id: reportId, export_type: "MARKDOWN", checksum },
    });
  });
  return { filename, markdown, checksum };
}

// ------------------------------------------------------------------ Journal de travail & erreurs
async function assertWorkPackageProject(projectId: string, workPackageId: unknown) {
  if (!workPackageId) return;
  const workPackage = await repoGetWorkPackageById(String(workPackageId));
  if (!workPackage || workPackage.project_id !== projectId) {
    throw new HttpError(400, "PO_WP_BAD_PROJECT", "Tâche invalide pour ce projet.");
  }
}

async function assertAssetProject(projectId: string, assetId: unknown) {
  if (!assetId) return;
  const asset = await repoGetAssetById(String(assetId));
  if (!asset || asset.project_id !== projectId) {
    throw new HttpError(400, "PO_ASSET_BAD_PROJECT", "Capture invalide pour ce projet.");
  }
}

export async function createWorkLog(actor: Actor, projectId: string, input: Record<string, unknown>, audit: AuditContext) {
  await requireProjectAccess(actor, projectId, "write");
  await assertWorkPackageProject(projectId, input.work_package_id);
  return withTransaction(async (tx) => {
    const log = await repoCreateWorkLog(tx, {
      project_id: projectId,
      work_package_id: (input.work_package_id as string | null) ?? null,
      branch_name: (input.branch_name as string | null) ?? null,
      pr_url: (input.pr_url as string | null) ?? null,
      commit_sha: (input.commit_sha as string | null) ?? null,
      module: (input.module as string | null) ?? null,
      action_type: input.action_type as PoWorkLogAction,
      title: String(input.title),
      description: (input.description as string | null) ?? null,
      before_state: (input.before_state as string | null) ?? null,
      after_state: (input.after_state as string | null) ?? null,
      created_by: actor.id,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.work-log.create", entity_type: "project_work_logs", entity_id: log.id,
      details: { project_id: projectId, action_type: log.action_type },
    });
    return { ...log, suggested_sections: suggestSectionsForWorkLog(log.action_type) };
  });
}

export async function listWorkLogs(actor: Actor, opts: { project_id: string; action_type?: string; page: number; pageSize: number }) {
  await requireProjectAccess(actor, opts.project_id, "read");
  return repoListWorkLogs(opts);
}

export async function createErrorRecord(actor: Actor, projectId: string, input: Record<string, unknown>, audit: AuditContext) {
  await requireProjectAccess(actor, projectId, "write");
  await assertWorkPackageProject(projectId, input.work_package_id);
  await assertAssetProject(projectId, input.screenshot_asset_id);
  return withTransaction(async (tx) => {
    const rec = await repoCreateErrorRecord(tx, {
      project_id: projectId,
      work_package_id: (input.work_package_id as string | null) ?? null,
      title: String(input.title),
      error_message: (input.error_message as string | null) ?? null,
      context: (input.context as string | null) ?? null,
      screenshot_asset_id: (input.screenshot_asset_id as string | null) ?? null,
      severity: String(input.severity ?? "MEDIUM"),
      created_by: actor.id,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.error.create", entity_type: "project_error_records", entity_id: rec.id,
      details: { project_id: projectId, severity: rec.severity },
    });
    return rec;
  });
}

export async function patchErrorRecord(actor: Actor, errorId: string, patch: Record<string, unknown>, audit: AuditContext) {
  const before = await repoGetErrorById(errorId);
  if (!before) throw new HttpError(404, "PO_ERROR_NOT_FOUND", "Erreur introuvable.");
  await requireProjectAccess(actor, before.project_id, "write");
  await assertAssetProject(before.project_id, patch.screenshot_asset_id);
  const effective = { ...patch };
  if (patch.status === "FIXED") {
    if (!patch.fix_summary && !before.fix_summary) {
      throw new HttpError(409, "PO_ERROR_FIX_SUMMARY_REQUIRED", "Une correction doit être résumée (fix_summary).");
    }
    effective.fixed_by = actor.id;
    effective.fixed_at = new Date().toISOString();
  }
  return withTransaction(async (tx) => {
    const rec = await repoPatchErrorRecord(tx, errorId, effective);
    if (!rec) throw new HttpError(404, "PO_ERROR_NOT_FOUND", "Erreur introuvable.");
    await insertAuditLog(tx, audit, {
      action: "project-office.error.update", entity_type: "project_error_records", entity_id: errorId,
      details: { project_id: before.project_id, fields: Object.keys(patch) },
    });
    return rec;
  });
}

export async function listErrorRecords(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListErrorRecords(projectId);
}

// ------------------------------------------------------------------ Captures (assets)
const ALLOWED_ASSET_MIME = new Set(["image/png", "image/jpeg"]);
const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 Mo par capture

export async function createAsset(
  actor: Actor,
  projectId: string,
  meta: { report_entry_id?: string | null; title: string; description?: string | null; asset_type: string },
  file: { buffer: Buffer; mimetype: string } | null,
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  if (meta.report_entry_id) {
    const entryProjectId = await repoGetEntryProjectId(meta.report_entry_id);
    if (!entryProjectId || entryProjectId !== projectId) {
      throw new HttpError(400, "PO_REPORT_ENTRY_BAD_PROJECT", "Section de rapport invalide pour ce projet.");
    }
  }
  let content: { content_base64: string; checksum: string; mime_type: string } | null = null;
  if (file) {
    if (!ALLOWED_ASSET_MIME.has(file.mimetype)) {
      throw new HttpError(415, "PO_ASSET_BAD_TYPE", "Formats acceptés : PNG, JPEG.");
    }
    const isPng = file.buffer.length >= 8
      && file.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = file.buffer.length >= 3
      && file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
    if ((file.mimetype === "image/png" && !isPng) || (file.mimetype === "image/jpeg" && !isJpeg)) {
      throw new HttpError(415, "PO_ASSET_BAD_SIGNATURE", "Le contenu du fichier ne correspond pas au format annoncé.");
    }
    if (file.buffer.length > MAX_ASSET_BYTES) {
      throw new HttpError(413, "PO_ASSET_TOO_LARGE", "Capture trop lourde (max 5 Mo).");
    }
    content = {
      content_base64: file.buffer.toString("base64"),
      checksum: crypto.createHash("sha256").update(file.buffer).digest("hex"),
      mime_type: file.mimetype,
    };
  }
  return withTransaction(async (tx) => {
    const asset = await repoCreateAsset(tx, {
      project_id: projectId,
      report_entry_id: meta.report_entry_id ?? null,
      title: meta.title,
      description: meta.description ?? null,
      asset_type: meta.asset_type,
      mime_type: content?.mime_type ?? null,
      width: null,
      height: null,
      content_base64: content?.content_base64 ?? null,
      checksum: content?.checksum ?? null,
      created_by: actor.id,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.report.asset.create", entity_type: "project_report_assets", entity_id: asset.id,
      details: { project_id: projectId, asset_type: meta.asset_type, has_file: !!content },
    });
    return asset;
  });
}

export async function listAssets(actor: Actor, projectId: string, reportEntryId?: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListAssets({ project_id: projectId, report_entry_id: reportEntryId });
}

export async function getAssetContent(actor: Actor, assetId: string) {
  const asset = await repoGetAssetById(assetId);
  if (!asset) throw new HttpError(404, "PO_ASSET_NOT_FOUND", "Capture introuvable.");
  await requireProjectAccess(actor, asset.project_id, "read");
  if (!asset.content_base64) throw new HttpError(404, "PO_ASSET_NO_CONTENT", "Capture sans contenu.");
  const buffer = Buffer.from(asset.content_base64, "base64");
  // Intégrité : le checksum stocké doit correspondre (pattern exports T&D).
  if (asset.checksum) {
    const recomputed = crypto.createHash("sha256").update(buffer).digest("hex");
    if (recomputed !== asset.checksum) throw new HttpError(409, "PO_ASSET_CHECKSUM_MISMATCH", "Intégrité de la capture compromise.");
  }
  return { buffer, mime_type: asset.mime_type ?? "application/octet-stream", title: asset.title };
}

export async function getExportContent(actor: Actor, exportId: string) {
  const exp = await repoGetReportExportById(exportId);
  if (!exp) throw new HttpError(404, "PO_EXPORT_NOT_FOUND", "Export introuvable.");
  const report = await repoGetReportById(exp.report_id);
  if (!report) throw new HttpError(404, "PO_EXPORT_NOT_FOUND", "Export introuvable.");
  await requireProjectAccess(actor, report.project_id, "read");
  if (!exp.file_base64) throw new HttpError(409, "PO_EXPORT_NO_FILE", "Export sans fichier figé.");
  const buffer = Buffer.from(exp.file_base64, "base64");
  const recomputed = crypto.createHash("sha256").update(buffer).digest("hex");
  if (recomputed !== exp.checksum) throw new HttpError(409, "PO_EXPORT_CHECKSUM_MISMATCH", "Intégrité de l'export compromise.");
  return { buffer, filename: exp.file_path, export_type: exp.export_type };
}
