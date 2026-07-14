import { Router } from "express";
import multer from "multer";
import { requireProjectOfficeAccess } from "../middlewares/require-project-office-access";
import * as base from "../controllers/project-office.controller";
import * as projects from "../controllers/project-office-projects.controller";
import * as work from "../controllers/project-office-work.controller";
import * as registers from "../controllers/project-office-registers.controller";
import * as report from "../controllers/project-office-report.controller";

// Monté après le socle authenticateToken (v1.routes.ts) → JWT requis d'office.
// Feature gate PROJECT_OFFICE (fail-closed) : /access est la SEULE route hors gate — elle répond
// { project_office: false } aux non-autorisés pour piloter la nav sans fuite (jamais 403 ici).
// Anti-IDOR : chaque service résout ressource → projet → rôle effectif (404 contrôlé si invisible).
const router = Router();

router.get("/access", base.getAccess);

router.use(requireProjectOfficeAccess);

// Projets & membres
router.get("/projects", projects.getProjects);
router.post("/projects", projects.postProject);
router.get("/projects/:id", projects.getProject);
router.patch("/projects/:id", projects.patchProject);
router.post("/projects/:id/members", projects.postMember);
router.delete("/projects/:id/members/:userId", projects.deleteMember);

// Work packages (lots / tâches)
router.get("/work-packages", work.getWorkPackages);
router.post("/work-packages", work.postWorkPackage);
router.get("/work-packages/:id", work.getWorkPackage);
router.patch("/work-packages/:id", work.patchWorkPackage);
router.post("/work-packages/:id/comments", work.postComment);
router.get("/work-packages/:id/activity", work.getWorkPackageActivity);
router.post("/work-packages/:id/evidence", work.postWorkPackageEvidence);
router.post("/work-packages/:id/dependencies", work.postDependency);

// Planning (Gantt / Kanban / jalons)
router.get("/projects/:id/gantt", work.getGantt);
router.get("/projects/:id/kanban", work.getKanban);
router.get("/projects/:id/milestones", work.getMilestones);
router.post("/projects/:id/milestones", work.postMilestone);
router.patch("/milestones/:id", work.patchMilestone);

// Cahier des charges versionné
router.get("/projects/:id/specs", registers.getSpecs);
router.post("/projects/:id/specs", registers.postSpec);
router.get("/specs/:id", registers.getSpec);
router.post("/specs/:id/versions", registers.postSpecVersion);
router.patch("/specs/:id/status", registers.patchSpecStatus);
router.post("/specs/:id/approve", registers.postSpecApprove);

// Registres : décisions / risques / actions / preuves / liens externes
router.get("/projects/:id/decisions", registers.getDecisions);
router.post("/projects/:id/decisions", registers.postDecision);
router.get("/projects/:id/risks", registers.getRisks);
router.post("/projects/:id/risks", registers.postRisk);
router.patch("/risks/:id", registers.patchRisk);
router.get("/projects/:id/actions", registers.getActions);
router.post("/projects/:id/actions", registers.postAction);
router.patch("/actions/:id", registers.patchAction);
router.get("/projects/:id/evidence", registers.getEvidence);
router.post("/projects/:id/evidence", registers.postEvidence);
const evidenceFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 12, fieldSize: 64 * 1024 },
});
router.post("/projects/:id/evidence/files", evidenceFileUpload.single("file"), registers.postEvidenceFile);
router.get("/projects/:id/evidence/files", registers.getEvidenceFiles);
router.get("/projects/:projectId/evidence-files/:id/content", registers.getProjectEvidenceFileContent);
router.get("/evidence-files/:id/download", registers.getEvidenceFileDownload);
router.get("/projects/:id/external-links", registers.getExternalLinks);
router.post("/external-links", registers.postExternalLink);

// Rapport de statut projet
router.get("/projects/:id/status-report", registers.getStatusReport);
router.get("/projects/:id/export.md", registers.getStatusReportMarkdown);
router.get("/projects/:id/export.pdf", registers.getStatusReportPdf);

// Rapport de projet Bac+5
const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, fieldSize: 64 * 1024 },
});
router.get("/report-templates", report.getTemplates);
router.get("/projects/:id/reports", report.getReports);
router.post("/projects/:id/reports", report.postReport);
router.get("/reports/:id", report.getReport);
router.get("/reports/:id/entries/:sectionId", report.getEntry);
router.patch("/reports/:id/entries/:sectionId", report.patchEntry);
router.post("/reports/:id/entries/:sectionId/generate", report.postEntryGenerate);
router.post("/reports/:id/entries/:sectionId/validate", report.postEntryValidate);
router.post("/reports/:id/entries/:sectionId/evidence", report.postEntryEvidence);
router.post("/reports/:id/generate", report.postGenerateFull);
router.post("/reports/:id/versions", report.postReportVersion);
router.get("/reports/:id/export.docx", report.getReportDocx);
router.get("/reports/:id/sections/:sectionId/export.docx", report.getSectionDocx);
router.get("/reports/:id/export.md", report.getReportMarkdown);
router.get("/report-exports/:id/download", report.getExportFile);

// Auto-documentation : journal de travail, erreurs/corrections, captures
router.get("/projects/:id/work-logs", report.getWorkLogs);
router.post("/projects/:id/work-logs", report.postWorkLog);
router.get("/projects/:id/errors", report.getErrors);
router.post("/projects/:id/errors", report.postError);
router.patch("/errors/:id", report.patchError);
router.get("/projects/:id/report-assets", report.getAssets);
router.post("/projects/:id/report-assets", assetUpload.single("file"), report.postAsset);
router.get("/report-assets/:id/content", report.getAssetContent);

export default router;
