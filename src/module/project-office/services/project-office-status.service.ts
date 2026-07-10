import PDFDocument from "pdfkit";
import { HttpError } from "../../../utils/httpError";
import { repoGetProjectById, repoListActivity } from "../repository/project-office.repository";
import { repoGetProjectStats } from "../repository/project-office-report.repository";
import {
  repoListActions,
  repoListRisks,
} from "../repository/project-office-registers.repository";
import { repoListAllWorkPackages, repoListMilestones } from "../repository/project-office-work.repository";
import type { Actor } from "../types/project-office.types";
import { requireProjectAccess } from "./project-office-access.service";

const WP_STATUS_LABELS: Record<string, string> = {
  BACKLOG: "Backlog", READY: "Prêt", IN_PROGRESS: "En cours", REVIEW: "Relecture",
  BLOCKED: "Bloqué", DONE: "Terminé", CANCELLED: "Annulé",
};

export async function buildStatusReport(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  const project = await repoGetProjectById(projectId);
  if (!project) throw new HttpError(404, "PO_PROJECT_NOT_FOUND", "Projet introuvable.");
  const [stats, workPackages, milestones, risks, actions, activity] = await Promise.all([
    repoGetProjectStats(projectId),
    repoListAllWorkPackages(projectId),
    repoListMilestones(projectId),
    repoListRisks(projectId),
    repoListActions(projectId),
    repoListActivity({ project_id: projectId, limit: 15 }),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const late = workPackages.filter(
    (w) => w.due_date && w.due_date < today && !["DONE", "CANCELLED"].includes(w.status)
  );
  // Santé simple et lisible : rouge si retard ou risque critique ouvert, orange si bloqué, sinon vert.
  const criticalRisk = risks.some((r) => r.status === "OPEN" && r.severity >= 16);
  const health: "GREEN" | "ORANGE" | "RED" =
    late.length > 0 || criticalRisk ? "RED" : stats.wp_blocked > 0 || stats.risks_open > 0 ? "ORANGE" : "GREEN";
  return {
    generated_at: new Date().toISOString(),
    project,
    health,
    stats,
    late_work_packages: late,
    milestones,
    risks_open: risks.filter((r) => r.status === "OPEN"),
    actions_open: actions.filter((a) => a.status === "OPEN" || a.status === "IN_PROGRESS"),
    recent_activity: activity,
  };
}

type StatusReport = Awaited<ReturnType<typeof buildStatusReport>>;

export function statusReportToMarkdown(r: StatusReport): string {
  const l: string[] = [];
  l.push(`# Rapport de statut — ${r.project.name} (${r.project.code})`);
  l.push("");
  l.push(`Généré le ${r.generated_at.slice(0, 16).replace("T", " ")} · Statut projet : ${r.project.status} · Santé : ${r.health}`);
  l.push("");
  l.push(`## Synthèse`);
  l.push("");
  l.push(`| Indicateur | Valeur |`);
  l.push(`|---|---|`);
  l.push(`| Tâches totales | ${r.stats.wp_total} |`);
  l.push(`| Tâches ouvertes | ${r.stats.wp_open} |`);
  l.push(`| Tâches en retard | ${r.stats.wp_late} |`);
  l.push(`| Tâches bloquées | ${r.stats.wp_blocked} |`);
  l.push(`| Tâches terminées | ${r.stats.wp_done} |`);
  l.push(`| Risques ouverts | ${r.stats.risks_open} |`);
  l.push(`| Actions ouvertes | ${r.stats.actions_open} |`);
  l.push("");
  if (r.late_work_packages.length) {
    l.push(`## Tâches en retard`);
    l.push("");
    for (const w of r.late_work_packages) l.push(`- **${w.code}** ${w.title} — échéance ${w.due_date}, statut ${WP_STATUS_LABELS[w.status] ?? w.status}`);
    l.push("");
  }
  l.push(`## Jalons`);
  l.push("");
  if (!r.milestones.length) l.push(`_Aucun jalon._`);
  for (const m of r.milestones) l.push(`- ${m.name} — ${m.due_date ?? "sans date"} (${m.status})`);
  l.push("");
  l.push(`## Risques ouverts`);
  l.push("");
  if (!r.risks_open.length) l.push(`_Aucun risque ouvert._`);
  for (const k of r.risks_open) l.push(`- **${k.title}** — sévérité ${k.severity} (P${k.probability}×I${k.impact})${k.mitigation ? ` — mitigation : ${k.mitigation}` : ""}`);
  l.push("");
  l.push(`## Actions correctives ouvertes`);
  l.push("");
  if (!r.actions_open.length) l.push(`_Aucune action ouverte._`);
  for (const a of r.actions_open) l.push(`- **${a.title}** (${a.source_type}) — ${a.status}${a.due_date ? `, échéance ${a.due_date}` : ""}`);
  l.push("");
  l.push(`## Activité récente`);
  l.push("");
  for (const act of r.recent_activity.slice(0, 10)) {
    l.push(`- ${act.created_at.slice(0, 16).replace("T", " ")} — ${act.actor_username ?? `user#${act.actor_id}`} · ${act.entity_type}/${act.action}`);
  }
  l.push("");
  return l.join("\n");
}

export function statusReportToPdf(r: StatusReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Rapport de statut ${r.project.code}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(`Rapport de statut — ${r.project.name}`, { continued: false });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#555")
      .text(`${r.project.code} · généré le ${r.generated_at.slice(0, 16).replace("T", " ")} · santé : ${r.health}`);
    doc.moveDown();

    const kv: [string, string][] = [
      ["Tâches totales", String(r.stats.wp_total)],
      ["Tâches ouvertes", String(r.stats.wp_open)],
      ["Tâches en retard", String(r.stats.wp_late)],
      ["Tâches bloquées", String(r.stats.wp_blocked)],
      ["Tâches terminées", String(r.stats.wp_done)],
      ["Risques ouverts", String(r.stats.risks_open)],
      ["Actions ouvertes", String(r.stats.actions_open)],
    ];
    doc.fillColor("#000").fontSize(13).text("Synthèse");
    doc.moveDown(0.3);
    doc.fontSize(10);
    for (const [k, v] of kv) doc.text(`${k} : ${v}`);
    doc.moveDown();

    const section = (title: string, lines: string[], empty: string) => {
      doc.fontSize(13).text(title);
      doc.moveDown(0.3);
      doc.fontSize(10);
      if (!lines.length) doc.fillColor("#777").text(empty).fillColor("#000");
      for (const line of lines) doc.text(`• ${line}`);
      doc.moveDown();
    };
    section("Tâches en retard", r.late_work_packages.map((w) => `${w.code} ${w.title} — échéance ${w.due_date}`), "Aucune.");
    section("Jalons", r.milestones.map((m) => `${m.name} — ${m.due_date ?? "sans date"} (${m.status})`), "Aucun jalon.");
    section("Risques ouverts", r.risks_open.map((k) => `${k.title} — sévérité ${k.severity} (P${k.probability}×I${k.impact})`), "Aucun.");
    section("Actions ouvertes", r.actions_open.map((a) => `${a.title} (${a.source_type}) — ${a.status}`), "Aucune.");

    doc.end();
  });
}
