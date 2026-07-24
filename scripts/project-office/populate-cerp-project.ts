/**
 * Peuplement du module Project Office avec le pilotage réel du projet CERP.
 *
 * Génère un fichier SQL idempotent (aucun DROP/DELETE, upserts par clés naturelles,
 * transaction unique) à appliquer via psql sur cerp_test puis cerp_prod.
 *
 *   npx tsx scripts/project-office/populate-cerp-project.ts --target test
 *   npx tsx scripts/project-office/populate-cerp-project.ts --target prod
 *
 * Sorties (non commitées, voir .gitignore du dossier) :
 *   scripts/project-office/out/populate.<target>.sql
 *   scripts/project-office/out/populate.<target>.meta.json  (comptes attendus par table)
 *
 * Idempotence — clés naturelles utilisées (relancer = no-op) :
 *   project_projects.code · project_work_packages(project_id, code) ·
 *   project_milestones(project_id, name) · project_specs(project_id, title) ·
 *   project_spec_versions(spec_id, version) · project_decisions(project_id, title) ·
 *   project_risks(project_id, title) · project_corrective_actions(project_id, title) ·
 *   project_evidence(project_id, title) · project_external_links(project_id, url, external_type) ·
 *   project_reports(project_id, title) · project_report_entries(report_id, section_id) ·
 *   project_report_versions(report_id, version) · project_dependencies(source, target, type)
 *
 * La traçabilité source (GIT_COMMIT / GITHUB_PR / DOC_SOURCE / MODULE_ANALYSIS / MANUAL_IMPORT)
 * est portée par les titres/descriptions des preuves et par project_external_links.external_id.
 * Aucun secret dans ce script ni dans le SQL généré.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA } from "./cerp-project-data";
import type { Target, WorkPackageDef } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ helpers SQL
/** Échappe une chaîne en littéral SQL simple. */
function lit(v: string | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

/** Littéral dollar-quoté pour les gros markdown (choisit un tag absent du contenu). */
function dollar(v: string): string {
  let tag = "$po$";
  let i = 0;
  while (v.includes(tag)) tag = `$po${++i}$`;
  return `${tag}${v}${tag}`;
}

function dateLit(v: string | null | undefined): string {
  if (!v) return "NULL";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Date invalide: ${v}`);
  return `'${v}'::date`;
}

function tsLit(v: string | null | undefined): string {
  if (!v) return "NULL";
  return `'${v}'::timestamptz`;
}

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "NULL" : String(v);
}

// ------------------------------------------------------------------ CLI
const targetArg = process.argv.indexOf("--target");
const target = (targetArg >= 0 ? process.argv[targetArg + 1] : "") as Target;
if (target !== "test" && target !== "prod") {
  console.error("Usage: npx tsx scripts/project-office/populate-cerp-project.ts --target <test|prod>");
  process.exit(1);
}

const cfg = DATA.targets[target];
const d = DATA;

// ------------------------------------------------------------------ validation du modèle
{
  const errors: string[] = [];
  const wpCodes = new Set<string>();
  for (const w of d.workPackages) {
    if (wpCodes.has(w.code)) errors.push(`WP dupliqué : ${w.code}`);
    wpCodes.add(w.code);
  }
  for (const w of d.workPackages) {
    if (w.parent && !wpCodes.has(w.parent)) errors.push(`Parent inconnu ${w.parent} (WP ${w.code})`);
    if ((w.progress ?? 0) < 0 || (w.progress ?? 0) > 100) errors.push(`Progress hors bornes (WP ${w.code})`);
  }
  for (const dep of d.dependencies) {
    if (!wpCodes.has(dep.source)) errors.push(`Dépendance : source inconnue ${dep.source}`);
    if (!wpCodes.has(dep.target)) errors.push(`Dépendance : cible inconnue ${dep.target}`);
  }
  const evTitles = new Set<string>();
  for (const e of d.evidence) {
    if (evTitles.has(e.title)) errors.push(`Preuve dupliquée : ${e.title}`);
    evTitles.add(e.title);
    if (e.wp && !wpCodes.has(e.wp)) errors.push(`Preuve « ${e.title} » : WP inconnu ${e.wp}`);
  }
  for (const a of d.actions) {
    if (a.evidenceTitle && !evTitles.has(a.evidenceTitle)) errors.push(`Action « ${a.title} » : preuve inconnue ${a.evidenceTitle}`);
  }
  const sections = new Set(d.report.entries.map((e) => e.section));
  if (sections.size !== d.report.entries.length) errors.push("Entrées de rapport : section dupliquée");
  for (const ee of d.report.entryEvidence) {
    if (!sections.has(ee.section)) errors.push(`entryEvidence : section inconnue ${ee.section}`);
    if (!evTitles.has(ee.evidenceTitle)) errors.push(`entryEvidence §${ee.section} : preuve inconnue ${ee.evidenceTitle}`);
  }
  const mNames = new Set(d.milestones.map((m) => m.name));
  if (mNames.size !== d.milestones.length) errors.push("Jalons : nom dupliqué");
  const specVs = new Set(d.spec.versions.map((v) => v.version));
  if (!specVs.has(d.spec.currentVersion)) errors.push(`Spec : currentVersion ${d.spec.currentVersion} absente`);
  if (!d.report.versions.some((v) => v.version === d.report.currentVersion)) errors.push(`Rapport : currentVersion ${d.report.currentVersion} absente`);
  if (errors.length) {
    console.error("Modèle invalide :\n - " + errors.join("\n - "));
    process.exit(1);
  }
}

// Préfixage des données de test (règle : données de test identifiables sur cerp_test).
const P = (s: string) => (cfg.prefix ? `${cfg.prefix}${s}` : s);
const PROJECT_CODE = cfg.projectCode;

const sql: string[] = [];
const emit = (s: string) => sql.push(s);

emit(`-- ============================================================================`);
emit(`-- Peuplement Project Office — projet CERP (cible : ${target})`);
emit(`-- Généré par scripts/project-office/populate-cerp-project.ts — NE PAS ÉDITER À LA MAIN`);
emit(`-- Idempotent : upserts par clés naturelles, aucun DROP/DELETE, transaction unique.`);
emit(`-- ============================================================================`);
emit(``);
emit(`\\set ON_ERROR_STOP on`);
emit(`BEGIN;`);
emit(``);

// Garde-fous : bonne base + utilisateur owner présent + template rapport présent.
emit(`DO $$
BEGIN
  IF current_database() <> ${lit(cfg.database)} THEN
    RAISE EXCEPTION 'Base attendue ${cfg.database}, base courante %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)}) THEN
    RAISE EXCEPTION 'Utilisateur owner ${cfg.ownerUsername} introuvable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.project_report_templates WHERE code = 'RAPPORT_BAC5_CERP') THEN
    RAISE EXCEPTION 'Template RAPPORT_BAC5_CERP absent — exécuter db/seeds/project-office-report-template.sql';
  END IF;
END $$;`);
emit(``);

// ------------------------------------------------------------------ projet
emit(`-- ------------------------------------------------------------------ Projet`);
emit(`INSERT INTO public.project_projects (code, name, description, owner_id, visibility, status, start_date, target_date)
SELECT ${lit(PROJECT_CODE)}, ${lit(P(d.project.name))}, ${dollar(d.project.description)},
       u.id, '${d.project.visibility}', '${d.project.status}', ${dateLit(d.project.startDate)}, ${dateLit(d.project.targetDate)}
FROM public.users u WHERE upper(btrim(u.username)) = ${lit(cfg.ownerUsername)}
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description, visibility = EXCLUDED.visibility,
  status = EXCLUDED.status, start_date = EXCLUDED.start_date, target_date = EXCLUDED.target_date,
  updated_at = now();`);
emit(``);
emit(`-- Owner membre du projet (rôle OWNER)`);
emit(`INSERT INTO public.project_members (project_id, user_id, role)
SELECT p.id, u.id, 'OWNER'
FROM public.project_projects p, public.users u
WHERE p.code = ${lit(PROJECT_CODE)} AND upper(btrim(u.username)) = ${lit(cfg.ownerUsername)}
ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'OWNER';`);
emit(``);

// ------------------------------------------------------------------ work packages
// Tri : EPIC puis LOT puis le reste, pour garantir la résolution des parents.
const wps = [...d.workPackages];
const rank = (w: WorkPackageDef) => (w.parent ? (wps.some((x) => x.parent === w.code) ? 1 : 2) : 0);
wps.sort((a, b) => rank(a) - rank(b));

emit(`-- ------------------------------------------------------------------ Work packages (${wps.length})`);
for (const w of wps) {
  const parentSel = w.parent
    ? `(SELECT id FROM public.project_work_packages WHERE project_id = p.id AND code = ${lit(w.parent)})`
    : "NULL";
  const assigneeSel = w.assign === false ? "NULL" : "u.id";
  emit(`INSERT INTO public.project_work_packages
  (project_id, parent_id, code, title, description, type, status, priority, assignee_id, reporter_id, start_date, due_date, progress_percent)
SELECT p.id, ${parentSel}, ${lit(w.code)}, ${lit(w.title)}, ${w.description ? dollar(w.description) : "NULL"},
       '${w.type}', '${w.status}', '${w.priority ?? "NORMAL"}', ${assigneeSel}, u.id,
       ${dateLit(w.start)}, ${dateLit(w.due)}, ${num(w.progress ?? 0)}
FROM public.project_projects p, public.users u
WHERE p.code = ${lit(PROJECT_CODE)} AND upper(btrim(u.username)) = ${lit(cfg.ownerUsername)}
ON CONFLICT (project_id, code) DO UPDATE SET
  parent_id = EXCLUDED.parent_id, title = EXCLUDED.title, description = EXCLUDED.description,
  type = EXCLUDED.type, status = EXCLUDED.status, priority = EXCLUDED.priority,
  start_date = EXCLUDED.start_date, due_date = EXCLUDED.due_date,
  progress_percent = EXCLUDED.progress_percent, updated_at = now();`);
}
emit(``);

// ------------------------------------------------------------------ dépendances
emit(`-- ------------------------------------------------------------------ Dépendances (${d.dependencies.length})`);
for (const dep of d.dependencies) {
  emit(`INSERT INTO public.project_dependencies (source_work_package_id, target_work_package_id, dependency_type)
SELECT s.id, t.id, '${dep.type}'
FROM public.project_projects p
JOIN public.project_work_packages s ON s.project_id = p.id AND s.code = ${lit(dep.source)}
JOIN public.project_work_packages t ON t.project_id = p.id AND t.code = ${lit(dep.target)}
WHERE p.code = ${lit(PROJECT_CODE)}
ON CONFLICT (source_work_package_id, target_work_package_id, dependency_type) DO NOTHING;`);
}
emit(``);

// ------------------------------------------------------------------ jalons (pas de contrainte unique → upsert manuel par (project, name))
emit(`-- ------------------------------------------------------------------ Jalons (${d.milestones.length})`);
for (const m of d.milestones) {
  emit(`UPDATE public.project_milestones ms SET description = ${dollar(m.description)}, due_date = ${dateLit(m.due)}, status = '${m.status}', updated_at = now()
FROM public.project_projects p WHERE ms.project_id = p.id AND p.code = ${lit(PROJECT_CODE)} AND ms.name = ${lit(m.name)};
INSERT INTO public.project_milestones (project_id, name, description, due_date, status)
SELECT p.id, ${lit(m.name)}, ${dollar(m.description)}, ${dateLit(m.due)}, '${m.status}'
FROM public.project_projects p WHERE p.code = ${lit(PROJECT_CODE)}
  AND NOT EXISTS (SELECT 1 FROM public.project_milestones x WHERE x.project_id = p.id AND x.name = ${lit(m.name)});`);
}
emit(``);

// ------------------------------------------------------------------ cahier des charges + versions
emit(`-- ------------------------------------------------------------------ Cahier des charges (1 spec, ${d.spec.versions.length} versions)`);
const specTitle = P(d.spec.title);
emit(`INSERT INTO public.project_specs (project_id, title, status)
SELECT p.id, ${lit(specTitle)}, '${d.spec.status}'
FROM public.project_projects p WHERE p.code = ${lit(PROJECT_CODE)}
  AND NOT EXISTS (SELECT 1 FROM public.project_specs s WHERE s.project_id = p.id AND s.title = ${lit(specTitle)});
UPDATE public.project_specs s SET status = '${d.spec.status}', updated_at = now()
FROM public.project_projects p WHERE s.project_id = p.id AND p.code = ${lit(PROJECT_CODE)} AND s.title = ${lit(specTitle)};`);
for (const v of d.spec.versions) {
  const approved = v.approvedAt
    ? `(SELECT id FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)}), ${tsLit(v.approvedAt)}`
    : `NULL, NULL`;
  emit(`INSERT INTO public.project_spec_versions (spec_id, version, content_markdown, change_summary, author_id, approved_by, approved_at)
SELECT s.id, ${lit(v.version)}, ${dollar(v.content)}, ${lit(v.changeSummary)},
       (SELECT id FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)}), ${approved}
FROM public.project_specs s JOIN public.project_projects p ON p.id = s.project_id
WHERE p.code = ${lit(PROJECT_CODE)} AND s.title = ${lit(specTitle)}
ON CONFLICT (spec_id, version) DO UPDATE SET
  content_markdown = EXCLUDED.content_markdown, change_summary = EXCLUDED.change_summary,
  approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at;`);
}
emit(`-- version courante du CDC = ${d.spec.currentVersion}`);
emit(`UPDATE public.project_specs s SET current_version_id = v.id, updated_at = now()
FROM public.project_projects p, public.project_spec_versions v
WHERE s.project_id = p.id AND p.code = ${lit(PROJECT_CODE)} AND s.title = ${lit(specTitle)}
  AND v.spec_id = s.id AND v.version = ${lit(d.spec.currentVersion)};`);
emit(``);

// ------------------------------------------------------------------ décisions
emit(`-- ------------------------------------------------------------------ Décisions (${d.decisions.length})`);
for (const dec of d.decisions) {
  const options = dec.options ? `'${JSON.stringify(dec.options).replace(/'/g, "''")}'::jsonb` : "NULL";
  emit(`UPDATE public.project_decisions x SET context = ${dollar(dec.context)}, options_json = ${options}, decision = ${dollar(dec.decision)}, consequences = ${dollar(dec.consequences)}, decided_at = ${tsLit(dec.decidedAt)}
FROM public.project_projects p WHERE x.project_id = p.id AND p.code = ${lit(PROJECT_CODE)} AND x.title = ${lit(dec.title)};
INSERT INTO public.project_decisions (project_id, title, context, options_json, decision, consequences, decided_by, decided_at)
SELECT p.id, ${lit(dec.title)}, ${dollar(dec.context)}, ${options}, ${dollar(dec.decision)}, ${dollar(dec.consequences)},
       (SELECT id FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)}), ${tsLit(dec.decidedAt)}
FROM public.project_projects p WHERE p.code = ${lit(PROJECT_CODE)}
  AND NOT EXISTS (SELECT 1 FROM public.project_decisions x WHERE x.project_id = p.id AND x.title = ${lit(dec.title)});`);
}
emit(``);

// ------------------------------------------------------------------ risques
emit(`-- ------------------------------------------------------------------ Risques (${d.risks.length})`);
for (const r of d.risks) {
  emit(`UPDATE public.project_risks x SET description = ${dollar(r.description)}, probability = ${r.probability}, impact = ${r.impact}, mitigation = ${dollar(r.mitigation)}, status = '${r.status}', owner_id = (SELECT id FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)}), updated_at = now()
FROM public.project_projects p WHERE x.project_id = p.id AND p.code = ${lit(PROJECT_CODE)} AND x.title = ${lit(r.title)};
INSERT INTO public.project_risks (project_id, title, description, probability, impact, mitigation, owner_id, status)
SELECT p.id, ${lit(r.title)}, ${dollar(r.description)}, ${r.probability}, ${r.impact}, ${dollar(r.mitigation)},
       (SELECT id FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)}), '${r.status}'
FROM public.project_projects p WHERE p.code = ${lit(PROJECT_CODE)}
  AND NOT EXISTS (SELECT 1 FROM public.project_risks x WHERE x.project_id = p.id AND x.title = ${lit(r.title)});`);
}
emit(``);

// ------------------------------------------------------------------ preuves (avant actions correctives : FK evidence_id)
emit(`-- ------------------------------------------------------------------ Preuves (${d.evidence.length})`);
for (const e of d.evidence) {
  const wpSel = e.wp
    ? `(SELECT id FROM public.project_work_packages WHERE project_id = p.id AND code = ${lit(e.wp)})`
    : "NULL";
  emit(`UPDATE public.project_evidence x SET type = '${e.type}', url = ${lit(e.url ?? null)}, description = ${e.description ? dollar(e.description) : "NULL"}, work_package_id = ${e.wp ? `(SELECT id FROM public.project_work_packages w WHERE w.project_id = x.project_id AND w.code = ${lit(e.wp)})` : "NULL"}
FROM public.project_projects p WHERE x.project_id = p.id AND p.code = ${lit(PROJECT_CODE)} AND x.title = ${lit(e.title)};
INSERT INTO public.project_evidence (project_id, work_package_id, type, title, url, description, created_by)
SELECT p.id, ${wpSel}, '${e.type}', ${lit(e.title)}, ${lit(e.url ?? null)}, ${e.description ? dollar(e.description) : "NULL"},
       (SELECT id FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)})
FROM public.project_projects p WHERE p.code = ${lit(PROJECT_CODE)}
  AND NOT EXISTS (SELECT 1 FROM public.project_evidence x WHERE x.project_id = p.id AND x.title = ${lit(e.title)});`);
}
emit(``);

// ------------------------------------------------------------------ actions correctives
emit(`-- ------------------------------------------------------------------ Actions correctives (${d.actions.length})`);
for (const a of d.actions) {
  const evSel = a.evidenceTitle
    ? `(SELECT id FROM public.project_evidence e WHERE e.project_id = p.id AND e.title = ${lit(a.evidenceTitle)})`
    : "NULL";
  emit(`UPDATE public.project_corrective_actions x SET source_type = '${a.source}', description = ${dollar(a.description)}, priority = '${a.priority}', due_date = ${dateLit(a.due)}, status = '${a.status}', evidence_id = ${a.evidenceTitle ? `(SELECT id FROM public.project_evidence e WHERE e.project_id = x.project_id AND e.title = ${lit(a.evidenceTitle)})` : "NULL"}, owner_id = (SELECT id FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)}), updated_at = now()
FROM public.project_projects p WHERE x.project_id = p.id AND p.code = ${lit(PROJECT_CODE)} AND x.title = ${lit(a.title)};
INSERT INTO public.project_corrective_actions (project_id, source_type, title, description, priority, owner_id, due_date, status, evidence_id)
SELECT p.id, '${a.source}', ${lit(a.title)}, ${dollar(a.description)}, '${a.priority}',
       (SELECT id FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)}), ${dateLit(a.due)}, '${a.status}', ${evSel}
FROM public.project_projects p WHERE p.code = ${lit(PROJECT_CODE)}
  AND NOT EXISTS (SELECT 1 FROM public.project_corrective_actions x WHERE x.project_id = p.id AND x.title = ${lit(a.title)});`);
}
emit(``);

// ------------------------------------------------------------------ liens externes
emit(`-- ------------------------------------------------------------------ Liens externes (${d.externalLinks.length})`);
for (const l of d.externalLinks) {
  emit(`INSERT INTO public.project_external_links (project_id, entity_type, entity_id, provider, external_type, external_id, url, status, created_by)
SELECT p.id, 'project', NULL, 'GITHUB', '${l.type}', ${lit(l.externalId)}, ${lit(l.url)}, ${lit(l.status ?? null)},
       (SELECT id FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)})
FROM public.project_projects p WHERE p.code = ${lit(PROJECT_CODE)}
  AND NOT EXISTS (SELECT 1 FROM public.project_external_links x WHERE x.project_id = p.id AND x.url = ${lit(l.url)} AND x.external_type = '${l.type}');`);
}
emit(``);

// ------------------------------------------------------------------ rapport Bac+5
const reportTitle = P(d.report.title);
emit(`-- ------------------------------------------------------------------ Rapport Bac+5 (1 rapport, ${d.report.entries.length} entrées, ${d.report.versions.length} versions)`);
emit(`INSERT INTO public.project_reports (project_id, template_id, title, author_id, academic_year, status)
SELECT p.id, t.id, ${lit(reportTitle)},
       (SELECT id FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)}),
       ${lit(d.report.academicYear)}, '${d.report.status}'
FROM public.project_projects p, public.project_report_templates t
WHERE p.code = ${lit(PROJECT_CODE)} AND t.code = 'RAPPORT_BAC5_CERP'
  AND NOT EXISTS (SELECT 1 FROM public.project_reports r WHERE r.project_id = p.id AND r.title = ${lit(reportTitle)});
UPDATE public.project_reports r SET status = '${d.report.status}', academic_year = ${lit(d.report.academicYear)}, updated_at = now()
FROM public.project_projects p WHERE r.project_id = p.id AND p.code = ${lit(PROJECT_CODE)} AND r.title = ${lit(reportTitle)};`);
emit(``);
for (const en of d.report.entries) {
  emit(`INSERT INTO public.project_report_entries (report_id, section_id, status, progress_percent, ai_draft_markdown, manual_notes, last_generated_at)
SELECT r.id, s.id, '${en.status}', ${num(en.progress)}, ${en.draft ? dollar(en.draft) : "NULL"}, ${en.notes ? dollar(en.notes) : "NULL"}, ${en.draft ? "now()" : "NULL"}
FROM public.project_reports r
JOIN public.project_projects p ON p.id = r.project_id
JOIN public.project_report_sections s ON s.template_id = r.template_id AND s.section_number = ${lit(en.section)}
WHERE p.code = ${lit(PROJECT_CODE)} AND r.title = ${lit(reportTitle)}
ON CONFLICT (report_id, section_id) DO UPDATE SET
  status = EXCLUDED.status, progress_percent = EXCLUDED.progress_percent,
  ai_draft_markdown = EXCLUDED.ai_draft_markdown, manual_notes = EXCLUDED.manual_notes,
  last_generated_at = EXCLUDED.last_generated_at, updated_at = now();`);
}
emit(``);
emit(`-- Liaison preuves ↔ entrées de rapport (${d.report.entryEvidence.length})`);
for (const ee of d.report.entryEvidence) {
  emit(`INSERT INTO public.project_report_entry_evidence (report_entry_id, evidence_id, relation_type)
SELECT en.id, ev.id, '${ee.relation}'
FROM public.project_reports r
JOIN public.project_projects p ON p.id = r.project_id
JOIN public.project_report_sections s ON s.template_id = r.template_id AND s.section_number = ${lit(ee.section)}
JOIN public.project_report_entries en ON en.report_id = r.id AND en.section_id = s.id
JOIN public.project_evidence ev ON ev.project_id = p.id AND ev.title = ${lit(ee.evidenceTitle)}
WHERE p.code = ${lit(PROJECT_CODE)} AND r.title = ${lit(reportTitle)}
ON CONFLICT (report_entry_id, evidence_id, relation_type) DO NOTHING;`);
}
emit(``);
for (const v of d.report.versions) {
  emit(`INSERT INTO public.project_report_versions (report_id, version, title, snapshot_json, generated_markdown, created_by)
SELECT r.id, ${lit(v.version)}, ${lit(v.title)}, '${JSON.stringify(v.snapshot).replace(/'/g, "''")}'::jsonb, ${v.markdown ? dollar(v.markdown) : "NULL"},
       (SELECT id FROM public.users WHERE upper(btrim(username)) = ${lit(cfg.ownerUsername)})
FROM public.project_reports r JOIN public.project_projects p ON p.id = r.project_id
WHERE p.code = ${lit(PROJECT_CODE)} AND r.title = ${lit(reportTitle)}
ON CONFLICT (report_id, version) DO UPDATE SET
  title = EXCLUDED.title, snapshot_json = EXCLUDED.snapshot_json, generated_markdown = EXCLUDED.generated_markdown;`);
}
emit(`-- version courante du rapport = ${d.report.currentVersion}`);
emit(`UPDATE public.project_reports r SET current_version_id = v.id, updated_at = now()
FROM public.project_projects p, public.project_report_versions v
WHERE r.project_id = p.id AND p.code = ${lit(PROJECT_CODE)} AND r.title = ${lit(reportTitle)}
  AND v.report_id = r.id AND v.version = ${lit(d.report.currentVersion)};`);
emit(``);

// ------------------------------------------------------------------ récap final
emit(`-- ------------------------------------------------------------------ Récapitulatif`);
emit(`SELECT 'project' AS entity, count(*) FROM public.project_projects WHERE code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'work_packages', count(*) FROM public.project_work_packages w JOIN public.project_projects p ON p.id = w.project_id WHERE p.code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'dependencies', count(*) FROM public.project_dependencies dp JOIN public.project_work_packages w ON w.id = dp.source_work_package_id JOIN public.project_projects p ON p.id = w.project_id WHERE p.code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'milestones', count(*) FROM public.project_milestones m JOIN public.project_projects p ON p.id = m.project_id WHERE p.code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'spec_versions', count(*) FROM public.project_spec_versions v JOIN public.project_specs s ON s.id = v.spec_id JOIN public.project_projects p ON p.id = s.project_id WHERE p.code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'decisions', count(*) FROM public.project_decisions x JOIN public.project_projects p ON p.id = x.project_id WHERE p.code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'risks', count(*) FROM public.project_risks x JOIN public.project_projects p ON p.id = x.project_id WHERE p.code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'actions', count(*) FROM public.project_corrective_actions x JOIN public.project_projects p ON p.id = x.project_id WHERE p.code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'evidence', count(*) FROM public.project_evidence x JOIN public.project_projects p ON p.id = x.project_id WHERE p.code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'external_links', count(*) FROM public.project_external_links x JOIN public.project_projects p ON p.id = x.project_id WHERE p.code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'report_entries', count(*) FROM public.project_report_entries e JOIN public.project_reports r ON r.id = e.report_id JOIN public.project_projects p ON p.id = r.project_id WHERE p.code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'report_entry_evidence', count(*) FROM public.project_report_entry_evidence ee JOIN public.project_report_entries e ON e.id = ee.report_entry_id JOIN public.project_reports r ON r.id = e.report_id JOIN public.project_projects p ON p.id = r.project_id WHERE p.code = ${lit(PROJECT_CODE)}
UNION ALL SELECT 'report_versions', count(*) FROM public.project_report_versions v JOIN public.project_reports r ON r.id = v.report_id JOIN public.project_projects p ON p.id = r.project_id WHERE p.code = ${lit(PROJECT_CODE)};`);
emit(``);
emit(`COMMIT;`);
emit(``);

// ------------------------------------------------------------------ écriture
const outDir = join(__dirname, "out");
mkdirSync(outDir, { recursive: true });
const sqlPath = join(outDir, `populate.${target}.sql`);
writeFileSync(sqlPath, sql.join("\n"), "utf8");

const meta = {
  generatedAt: new Date().toISOString(),
  target,
  database: cfg.database,
  projectCode: PROJECT_CODE,
  owner: cfg.ownerUsername,
  expected: {
    work_packages: d.workPackages.length,
    dependencies: d.dependencies.length,
    milestones: d.milestones.length,
    spec_versions: d.spec.versions.length,
    decisions: d.decisions.length,
    risks: d.risks.length,
    actions: d.actions.length,
    evidence: d.evidence.length,
    external_links: d.externalLinks.length,
    report_entries: d.report.entries.length,
    report_entry_evidence: d.report.entryEvidence.length,
    report_versions: d.report.versions.length,
  },
};
const metaPath = join(outDir, `populate.${target}.meta.json`);
writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

console.log(`SQL généré : ${sqlPath}`);
console.log(`Meta       : ${metaPath}`);
console.log(JSON.stringify(meta.expected, null, 2));
