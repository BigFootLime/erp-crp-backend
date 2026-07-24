import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ensureDocumentStoragePath,
  getDocumentStoragePath,
  isPathInsideDirectory,
  requirePersistentDocumentsRoot,
} from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";
import {
  insertAuditLog,
  insertProjectActivity,
  isPgUniqueViolation,
  withTransaction,
  type AuditContext,
} from "../repository/project-office.repository";
import {
  repoApproveSpecVersion,
  repoCreateAction,
  repoCreateDecision,
  repoCreateEvidence,
  repoCreateEvidenceFile,
  repoCreateExternalLink,
  repoCreateRisk,
  repoCreateSpec,
  repoCreateSpecVersion,
  repoGetActionById,
  repoGetEvidenceById,
  repoGetEvidenceFileById,
  repoListEvidenceFiles,
  repoGetExternalEntityProjectId,
  repoGetRiskById,
  repoGetSpecById,
  repoGetSpecVersionById,
  repoListActions,
  repoListDecisions,
  repoListEvidence,
  repoListExternalLinks,
  repoListRisks,
  repoListSpecs,
  repoListSpecVersions,
  repoPatchAction,
  repoPatchRisk,
  repoSetSpecStatus,
  repoFindEvidenceFileByProjectHash,
} from "../repository/project-office-registers.repository";
import { repoGetWorkPackageById } from "../repository/project-office-work.repository";
import type { Actor, EvidenceFileRow, SpecRow } from "../types/project-office.types";
import { requireProjectAccess } from "./project-office-access.service";

// -------------------------------------------------------------- Cahier des charges versionné
export async function listSpecs(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListSpecs(projectId);
}

export async function requireSpec(actor: Actor, specId: string, need: "read" | "write" | "manage" = "read"): Promise<SpecRow> {
  const spec = await repoGetSpecById(specId);
  if (!spec) throw new HttpError(404, "PO_SPEC_NOT_FOUND", "Cahier des charges introuvable.");
  await requireProjectAccess(actor, spec.project_id, need);
  return spec;
}

export async function createSpec(
  actor: Actor,
  projectId: string,
  input: { title: string; content_markdown?: string },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  return withTransaction(async (tx) => {
    const spec = await repoCreateSpec(tx, { project_id: projectId, title: input.title });
    let version = null;
    if (input.content_markdown) {
      version = await repoCreateSpecVersion(tx, {
        spec_id: spec.id, version: "1.0", content_markdown: input.content_markdown,
        change_summary: "Version initiale", author_id: actor.id,
      });
    }
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "spec", entity_id: spec.id, action: "create",
      actor_id: actor.id, after_json: { title: spec.title, initial_version: version?.version ?? null },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.spec.create", entity_type: "project_specs", entity_id: spec.id,
      details: { project_id: projectId },
    });
    return { ...spec, current_version_id: version?.id ?? null, current_version: version?.version ?? null };
  });
}

export async function getSpecDetail(actor: Actor, specId: string) {
  const spec = await requireSpec(actor, specId, "read");
  const versions = await repoListSpecVersions(specId);
  return { spec, versions };
}

export async function createSpecVersion(
  actor: Actor,
  specId: string,
  input: { version: string; content_markdown: string; change_summary?: string | null },
  audit: AuditContext
) {
  const spec = await requireSpec(actor, specId, "write");
  try {
    return await withTransaction(async (tx) => {
      const version = await repoCreateSpecVersion(tx, {
        spec_id: specId, version: input.version, content_markdown: input.content_markdown,
        change_summary: input.change_summary ?? null, author_id: actor.id,
      });
      // Une spec APPROVED est FIGÉE : une nouvelle version la remet en travail (DRAFT).
      if (spec.status === "APPROVED" || spec.status === "REVIEW") {
        await repoSetSpecStatus(tx, specId, "DRAFT");
      }
      await insertProjectActivity(tx, {
        project_id: spec.project_id, entity_type: "spec", entity_id: specId, action: "new_version",
        actor_id: actor.id, after_json: { version: input.version, change_summary: input.change_summary ?? null },
      });
      await insertAuditLog(tx, audit, {
        action: "project-office.spec.version.create", entity_type: "project_spec_versions", entity_id: version.id,
        details: { spec_id: specId, version: input.version },
      });
      return version;
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) throw new HttpError(409, "PO_SPEC_VERSION_TAKEN", "Cette version existe déjà pour ce cahier des charges.");
    throw err;
  }
}

export async function patchSpecStatus(actor: Actor, specId: string, status: "DRAFT" | "REVIEW" | "OBSOLETE", audit: AuditContext) {
  const spec = await requireSpec(actor, specId, "write");
  if (status === "REVIEW" && !spec.current_version_id) {
    throw new HttpError(409, "PO_SPEC_NO_VERSION", "Impossible de passer en relecture sans version.");
  }
  await withTransaction(async (tx) => {
    await repoSetSpecStatus(tx, specId, status);
    await insertProjectActivity(tx, {
      project_id: spec.project_id, entity_type: "spec", entity_id: specId, action: "status",
      actor_id: actor.id, before_json: { status: spec.status }, after_json: { status },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.spec.status", entity_type: "project_specs", entity_id: specId,
      details: { from: spec.status, to: status },
    });
  });
  return { ...spec, status };
}

export async function approveSpec(actor: Actor, specId: string, audit: AuditContext) {
  // Approbation = MANAGER+ du projet, et JAMAIS l'auteur de la version courante (no-self-approve).
  const spec = await requireSpec(actor, specId, "manage");
  if (!spec.current_version_id) throw new HttpError(409, "PO_SPEC_NO_VERSION", "Aucune version à approuver.");
  const version = await repoGetSpecVersionById(spec.current_version_id);
  if (!version) throw new HttpError(409, "PO_SPEC_NO_VERSION", "Version courante introuvable.");
  if (version.author_id === actor.id) {
    throw new HttpError(403, "PO_SPEC_SELF_APPROVE", "L'auteur d'une version ne peut pas l'approuver lui-même.");
  }
  if (spec.status === "APPROVED" && version.approved_at) {
    throw new HttpError(409, "PO_SPEC_ALREADY_APPROVED", "Cette version est déjà approuvée.");
  }
  return withTransaction(async (tx) => {
    const approved = await repoApproveSpecVersion(tx, version.id, actor.id);
    if (!approved) throw new HttpError(409, "PO_SPEC_ALREADY_APPROVED", "Cette version est déjà approuvée.");
    await repoSetSpecStatus(tx, specId, "APPROVED");
    await insertProjectActivity(tx, {
      project_id: spec.project_id, entity_type: "spec", entity_id: specId, action: "approve",
      actor_id: actor.id, after_json: { version: approved.version, approved_by: actor.id },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.spec.approve", entity_type: "project_spec_versions", entity_id: approved.id,
      details: { spec_id: specId, version: approved.version },
    });
    return { spec: { ...spec, status: "APPROVED" as const }, version: approved };
  });
}

// -------------------------------------------------------------- Décisions
export async function listDecisions(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListDecisions(projectId);
}

export async function createDecision(
  actor: Actor,
  projectId: string,
  input: { title: string; context?: string | null; options_json?: unknown; decision: string; consequences?: string | null },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  return withTransaction(async (tx) => {
    const decision = await repoCreateDecision(tx, {
      project_id: projectId, title: input.title, context: input.context ?? null,
      options_json: input.options_json ?? null, decision: input.decision,
      consequences: input.consequences ?? null, decided_by: actor.id,
    });
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "decision", entity_id: decision.id, action: "create",
      actor_id: actor.id, after_json: { title: input.title },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.decision.create", entity_type: "project_decisions", entity_id: decision.id,
      details: { project_id: projectId },
    });
    return decision;
  });
}

// -------------------------------------------------------------- Risques
export async function listRisks(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListRisks(projectId);
}

export async function createRisk(
  actor: Actor,
  projectId: string,
  input: { title: string; description?: string | null; probability: number; impact: number; mitigation?: string | null; owner_id?: number | null },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  return withTransaction(async (tx) => {
    const risk = await repoCreateRisk(tx, {
      project_id: projectId, title: input.title, description: input.description ?? null,
      probability: input.probability, impact: input.impact,
      mitigation: input.mitigation ?? null, owner_id: input.owner_id ?? null,
    });
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "risk", entity_id: risk.id, action: "create",
      actor_id: actor.id, after_json: { title: input.title, severity: risk.severity },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.risk.create", entity_type: "project_risks", entity_id: risk.id,
      details: { project_id: projectId, severity: risk.severity },
    });
    return risk;
  });
}

export async function patchRisk(actor: Actor, riskId: string, patch: Record<string, unknown>, audit: AuditContext) {
  const before = await repoGetRiskById(riskId);
  if (!before) throw new HttpError(404, "PO_RISK_NOT_FOUND", "Risque introuvable.");
  await requireProjectAccess(actor, before.project_id, "write");
  return withTransaction(async (tx) => {
    const risk = await repoPatchRisk(tx, riskId, patch);
    if (!risk) throw new HttpError(404, "PO_RISK_NOT_FOUND", "Risque introuvable.");
    const changed = Object.keys(patch);
    await insertProjectActivity(tx, {
      project_id: before.project_id, entity_type: "risk", entity_id: riskId, action: "update",
      actor_id: actor.id,
      before_json: Object.fromEntries(changed.map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null])),
      after_json: patch,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.risk.update", entity_type: "project_risks", entity_id: riskId,
      details: { project_id: before.project_id, fields: changed },
    });
    return risk;
  });
}

// -------------------------------------------------------------- Actions correctives
export async function listActions(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListActions(projectId);
}

export async function createAction(
  actor: Actor,
  projectId: string,
  input: {
    source_type: string; title: string; description?: string | null; priority: string;
    owner_id?: number | null; due_date?: string | null; evidence_id?: string | null;
  },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  if (input.evidence_id) {
    const ev = await repoGetEvidenceById(input.evidence_id);
    if (!ev || ev.project_id !== projectId) throw new HttpError(400, "PO_EVIDENCE_BAD_PROJECT", "Preuve invalide pour ce projet.");
  }
  return withTransaction(async (tx) => {
    const action = await repoCreateAction(tx, {
      project_id: projectId, source_type: input.source_type, title: input.title,
      description: input.description ?? null, priority: input.priority,
      owner_id: input.owner_id ?? null, due_date: input.due_date ?? null, evidence_id: input.evidence_id ?? null,
    });
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "action", entity_id: action.id, action: "create",
      actor_id: actor.id, after_json: { title: input.title, source_type: input.source_type },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.action.create", entity_type: "project_corrective_actions", entity_id: action.id,
      details: { project_id: projectId },
    });
    return action;
  });
}

export async function patchAction(actor: Actor, actionId: string, patch: Record<string, unknown>, audit: AuditContext) {
  const before = await repoGetActionById(actionId);
  if (!before) throw new HttpError(404, "PO_ACTION_NOT_FOUND", "Action introuvable.");
  await requireProjectAccess(actor, before.project_id, "write");
  if (patch.evidence_id) {
    const ev = await repoGetEvidenceById(String(patch.evidence_id));
    if (!ev || ev.project_id !== before.project_id) throw new HttpError(400, "PO_EVIDENCE_BAD_PROJECT", "Preuve invalide pour ce projet.");
  }
  return withTransaction(async (tx) => {
    const action = await repoPatchAction(tx, actionId, patch);
    if (!action) throw new HttpError(404, "PO_ACTION_NOT_FOUND", "Action introuvable.");
    const changed = Object.keys(patch);
    await insertProjectActivity(tx, {
      project_id: before.project_id, entity_type: "action", entity_id: actionId, action: "update",
      actor_id: actor.id,
      before_json: Object.fromEntries(changed.map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null])),
      after_json: patch,
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.action.update", entity_type: "project_corrective_actions", entity_id: actionId,
      details: { project_id: before.project_id, fields: changed },
    });
    return action;
  });
}

// -------------------------------------------------------------- Preuves & liens externes
export async function listEvidence(actor: Actor, opts: { project_id: string; work_package_id?: string; page: number; pageSize: number }) {
  await requireProjectAccess(actor, opts.project_id, "read");
  return repoListEvidence(opts);
}

export async function createEvidence(
  actor: Actor,
  projectId: string,
  input: { work_package_id?: string | null; type: string; title: string; url?: string | null; description?: string | null },
  audit: AuditContext
) {
  await requireProjectAccess(actor, projectId, "write");
  if (input.work_package_id) {
    const workPackage = await repoGetWorkPackageById(input.work_package_id);
    if (!workPackage || workPackage.project_id !== projectId) {
      throw new HttpError(400, "PO_WP_BAD_PROJECT", "Tâche invalide pour ce projet.");
    }
  }
  return withTransaction(async (tx) => {
    const evidence = await repoCreateEvidence(tx, {
      project_id: projectId, work_package_id: input.work_package_id ?? null, type: input.type,
      title: input.title, url: input.url ?? null, description: input.description ?? null, created_by: actor.id,
    });
    await insertProjectActivity(tx, {
      project_id: projectId, entity_type: "evidence", entity_id: evidence.id, action: "create",
      actor_id: actor.id, after_json: { type: input.type, title: input.title },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.evidence.create", entity_type: "project_evidence", entity_id: evidence.id,
      details: { project_id: projectId },
    });
    return evidence;
  });
}

const EVIDENCE_FILES_DIRECTORY = "project-office-evidence";
const MAX_EVIDENCE_FILE_SIZE = 25 * 1024 * 1024;
type EvidenceFileKind = "pdf" | "png" | "jpeg" | "webp" | "pptx" | "xlsx" | "docx" | "bizagi-bpm";

const EVIDENCE_FILE_PROFILES: Record<EvidenceFileKind, { mime: string; extensions: readonly string[] }> = {
  pdf: { mime: "application/pdf", extensions: [".pdf"] },
  png: { mime: "image/png", extensions: [".png"] },
  jpeg: { mime: "image/jpeg", extensions: [".jpg", ".jpeg"] },
  webp: { mime: "image/webp", extensions: [".webp"] },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extensions: [".pptx"] },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extensions: [".xlsx"] },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extensions: [".docx"] },
  "bizagi-bpm": { mime: "application/xml", extensions: [".bpm"] },
};

const BPM_BIZAGI_MIME_TYPES = new Set([
  "application/xml",
  "text/xml",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);
const ALLOWED_EVIDENCE_MIME_TYPES = new Set([
  ...Object.values(EVIDENCE_FILE_PROFILES).map((profile) => profile.mime),
  "text/xml",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);

function sanitizeEvidenceFilename(originalName: string): string {
  const basename = path.basename(originalName || "evidence");
  const normalized = basename
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return normalized.slice(0, 180) || "evidence";
}

function evidenceExtension(sanitizedName: string): string {
  const ext = path.extname(sanitizedName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

function fileKindForMimeAndExtension(mimeType: string, extension: string): EvidenceFileKind | null {
  for (const [kind, profile] of Object.entries(EVIDENCE_FILE_PROFILES) as Array<[EvidenceFileKind, { mime: string; extensions: readonly string[] }]>) {
    const mimeMatches = kind === "bizagi-bpm" ? BPM_BIZAGI_MIME_TYPES.has(mimeType) : profile.mime === mimeType;
    if (mimeMatches && profile.extensions.includes(extension)) return kind;
  }
  return null;
}

function hasZipMagic(buffer: Buffer): boolean {
  return buffer.length >= 4
    && ((buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04)
      || (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x05 && buffer[3] === 0x06));
}

function hasOoxmlPackageEntries(buffer: Buffer, expectedFolder: string): boolean {
  // Uploads are capped at 25 MiB. Scanning the complete ZIP payload also covers
  // archives whose central directory is located beyond the first 512 KiB.
  const probe = buffer.toString("latin1");
  return probe.includes("[Content_Types].xml") && probe.includes(expectedFolder);
}

function hasBizagiBpmPackageEntries(buffer: Buffer): boolean {
  const probe = buffer.toString("latin1");
  return probe.includes("ModelInfo.xml") && probe.includes(".diag");
}

export function assertAcceptedEvidenceFile(
  file: Express.Multer.File | undefined
): asserts file is Express.Multer.File {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new HttpError(400, "PO_EVIDENCE_FILE_REQUIRED", "Un fichier de preuve est requis.");
  }
  if (file.size <= 0 || file.size > MAX_EVIDENCE_FILE_SIZE) {
    throw new HttpError(413, "PO_EVIDENCE_FILE_SIZE", "Le fichier doit peser entre 1 octet et 25 Mo.");
  }
  if (!ALLOWED_EVIDENCE_MIME_TYPES.has(file.mimetype)) {
    throw new HttpError(415, "PO_EVIDENCE_FILE_TYPE", "Type de fichier non autorisé pour une preuve.");
  }

  const sanitizedName = sanitizeEvidenceFilename(file.originalname || "evidence");
  const extension = evidenceExtension(sanitizedName);
  const kind = fileKindForMimeAndExtension(file.mimetype, extension);
  if (!kind) {
    throw new HttpError(415, "PO_EVIDENCE_FILE_TYPE", "Le MIME, l'extension ou la catégorie ne sont pas autorisés.");
  }

  const buffer = file.buffer;
  const startsWith = (...bytes: number[]) => bytes.every((byte, index) => buffer[index] === byte);
  const validSignature = (() => {
    switch (kind) {
      case "pdf": return startsWith(0x25, 0x50, 0x44, 0x46, 0x2d);
      case "png": return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
      case "jpeg": return startsWith(0xff, 0xd8, 0xff);
      case "webp": return startsWith(0x52, 0x49, 0x46, 0x46) && buffer.subarray(8, 12).toString("ascii") === "WEBP";
      case "pptx": return hasZipMagic(buffer) && hasOoxmlPackageEntries(buffer, "ppt/");
      case "xlsx": return hasZipMagic(buffer) && hasOoxmlPackageEntries(buffer, "xl/");
      case "docx": return hasZipMagic(buffer) && hasOoxmlPackageEntries(buffer, "word/");
      case "bizagi-bpm": {
        if (hasZipMagic(buffer)) return hasBizagiBpmPackageEntries(buffer);
        const xml = buffer.subarray(0, Math.min(buffer.length, 256 * 1024)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
        return (xml.startsWith("<?xml") || xml.startsWith("<")) && /bizagi/i.test(xml);
      }
    }
  })();
  if (!validSignature) {
    throw new HttpError(415, "PO_EVIDENCE_FILE_SIGNATURE", "La signature binaire ne correspond pas au type annoncé.");
  }
}

function evidenceStorageRoot(): string {
  try {
    requirePersistentDocumentsRoot();
    return ensureDocumentStoragePath(EVIDENCE_FILES_DIRECTORY);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Document storage unavailable";
    throw new HttpError(503, "PO_EVIDENCE_STORAGE_UNAVAILABLE", detail);
  }
}

export async function uploadEvidenceFile(
  actor: Actor,
  projectId: string,
  input: {
    work_package_id?: string | null; title?: string; description?: string | null;
    category: "DOCUMENT" | "VSM"; version_number: number;
    status: "BROUILLON" | "VALIDE" | "OBSOLETE"; date_effet?: string | null;
    visibility: "PRIVATE" | "INTERNAL";
  },
  file: Express.Multer.File | undefined,
  audit: AuditContext
): Promise<{ evidence: Awaited<ReturnType<typeof repoCreateEvidence>>; file: EvidenceFileRow }> {
  await requireProjectAccess(actor, projectId, "write");
  assertAcceptedEvidenceFile(file);
  if (input.work_package_id) {
    const workPackage = await repoGetWorkPackageById(input.work_package_id);
    if (!workPackage || workPackage.project_id !== projectId) {
      throw new HttpError(400, "PO_WP_BAD_PROJECT", "Tâche invalide pour ce projet.");
    }
  }

  const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const duplicate = await repoFindEvidenceFileByProjectHash(projectId, sha256);
  if (duplicate) {
    throw new HttpError(409, "PO_EVIDENCE_FILE_DUPLICATE", "Ce fichier est déjà enregistré dans ce projet.");
  }

  const originalName = file.originalname || "evidence";
  const sanitizedName = sanitizeEvidenceFilename(originalName);
  const storageName = `${crypto.randomUUID()}${evidenceExtension(sanitizedName)}`;
  const storageKey = `${EVIDENCE_FILES_DIRECTORY}/${storageName}`;
  const storageRoot = evidenceStorageRoot();
  const destination = getDocumentStoragePath(storageKey);
  if (!isPathInsideDirectory(storageRoot, destination)) {
    throw new HttpError(400, "PO_EVIDENCE_FILE_PATH", "Chemin de stockage invalide.");
  }

  let written = false;
  try {
    await fs.writeFile(destination, file.buffer, { flag: "wx" });
    written = true;
    return await withTransaction(async (tx) => {
      const evidence = await repoCreateEvidence(tx, {
        project_id: projectId,
        work_package_id: input.work_package_id ?? null,
        type: input.category === "VSM" ? "VSM" : "DOCUMENT",
        title: input.title?.trim() || sanitizedName,
        url: null,
        description: input.description ?? null,
        created_by: actor.id,
      });
      const evidenceFile = await repoCreateEvidenceFile(tx, {
        evidence_id: evidence.id,
        project_id: projectId,
        storage_key: storageKey,
        original_name: originalName,
        sanitized_name: storageName,
        mime_type: file.mimetype,
        size_bytes: file.size,
        sha256,
        category: input.category,
        version_number: input.version_number,
        status: input.status,
        date_effet: input.date_effet ?? null,
        visibility: input.visibility,
        created_by: actor.id,
      });
      await insertProjectActivity(tx, {
        project_id: projectId, entity_type: "evidence", entity_id: evidence.id, action: "file-upload",
        actor_id: actor.id,
        after_json: { file_id: evidenceFile.id, category: input.category, sha256, size_bytes: file.size },
      });
      await insertAuditLog(tx, audit, {
        action: "project-office.evidence.file-upload", entity_type: "project_evidence_files", entity_id: evidenceFile.id,
        details: { project_id: projectId, evidence_id: evidence.id, category: input.category, sha256, size_bytes: file.size },
      });
      return { evidence, file: evidenceFile };
    });
  } catch (err) {
    if (written) await fs.unlink(destination).catch(() => undefined);
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "PO_EVIDENCE_FILE_DUPLICATE", "Ce fichier est déjà enregistré dans ce projet.");
    }
    throw err;
  }
}

export async function downloadEvidenceFile(actor: Actor, fileId: string): Promise<EvidenceFileRow & { buffer: Buffer }> {
  const file = await repoGetEvidenceFileById(fileId);
  if (!file) throw new HttpError(404, "PO_EVIDENCE_FILE_NOT_FOUND", "Fichier de preuve introuvable.");
  await requireProjectAccess(actor, file.project_id, "read");
  const storageRoot = evidenceStorageRoot();
  const source = getDocumentStoragePath(file.storage_key);
  if (!isPathInsideDirectory(storageRoot, source)) {
    throw new HttpError(404, "PO_EVIDENCE_FILE_NOT_FOUND", "Fichier de preuve introuvable.");
  }
  try {
    const buffer = await fs.readFile(source);
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    if (buffer.byteLength !== file.size_bytes || sha256 !== file.sha256) {
      throw new HttpError(409, "PO_EVIDENCE_FILE_INTEGRITY", "L'intégrité du fichier de preuve ne peut pas être vérifiée.");
    }
    return { ...file, buffer };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, "PO_EVIDENCE_FILE_NOT_FOUND", "Fichier de preuve introuvable.");
  }
}

export async function downloadProjectEvidenceFile(
  actor: Actor,
  projectId: string,
  fileId: string
): Promise<EvidenceFileRow & { buffer: Buffer }> {
  await requireProjectAccess(actor, projectId, "read");
  const file = await downloadEvidenceFile(actor, fileId);
  if (file.project_id !== projectId) {
    throw new HttpError(404, "PO_EVIDENCE_FILE_NOT_FOUND", "Fichier de preuve introuvable.");
  }
  return file;
}

export async function listEvidenceFiles(
  actor: Actor,
  opts: { project_id: string; category?: "DOCUMENT" | "VSM"; page: number; pageSize: number }
) {
  await requireProjectAccess(actor, opts.project_id, "read");
  return repoListEvidenceFiles(opts);
}

export async function listExternalLinks(actor: Actor, projectId: string) {
  await requireProjectAccess(actor, projectId, "read");
  return repoListExternalLinks(projectId);
}

export async function createExternalLink(
  actor: Actor,
  input: {
    project_id: string; entity_type: string; entity_id?: string | null; provider: string;
    external_type: string; external_id?: string | null; url: string; status?: string | null;
  },
  audit: AuditContext
) {
  await requireProjectAccess(actor, input.project_id, "write");
  if (input.entity_id) {
    const entityProjectId = await repoGetExternalEntityProjectId(
      input.entity_type as "project" | "work_package" | "spec" | "decision" | "risk" | "action",
      input.entity_id
    );
    if (!entityProjectId || entityProjectId !== input.project_id) {
      throw new HttpError(400, "PO_EXTERNAL_ENTITY_BAD_PROJECT", "Entité externe invalide pour ce projet.");
    }
  }
  return withTransaction(async (tx) => {
    const link = await repoCreateExternalLink(tx, {
      project_id: input.project_id, entity_type: input.entity_type, entity_id: input.entity_id ?? null,
      provider: input.provider, external_type: input.external_type, external_id: input.external_id ?? null,
      url: input.url, status: input.status ?? null, created_by: actor.id,
    });
    await insertProjectActivity(tx, {
      project_id: input.project_id, entity_type: "external_link", entity_id: link.id, action: "create",
      actor_id: actor.id, after_json: { provider: input.provider, external_type: input.external_type, url: input.url },
    });
    await insertAuditLog(tx, audit, {
      action: "project-office.external-link.create", entity_type: "project_external_links", entity_id: link.id,
      details: { project_id: input.project_id, provider: input.provider },
    });
    return link;
  });
}
