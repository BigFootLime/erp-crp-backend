import path from "node:path";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import * as ged from "../../ged/services/ged.service";
import { assertGedParentLinkWritable } from "../../ged/services/ged-parent-authorization.service";
import { assertMetrologyCapability } from "../domain/metrology-policy";
import type { GedDocumentDetail } from "../../ged/types/ged.types";
import { repoGetImportedEquipmentSource, repoListEquipmentDocumentRefs } from "../repository/metrology-documents.repository";

const ENTITY_TYPE = "METROLOGIE_EQUIPEMENT";
const CLASS_KEY = "METROLOGIE_SCAN";
export const scanMetadataSchema = z.object({
  kind: z.enum(["MD15_SCAN", "MAINTENANCE_SCAN", "NOTICE", "OTHER"]),
  label: z.string().trim().min(1).max(240).optional(),
  observed_on: z.preprocess(v => v === "" ? null : v, z.iso.date().nullable().optional()),
  notes: z.string().max(5000).nullable().optional(),
}).strict();
export type ScanMetadata = z.infer<typeof scanMetadataSchema>;
export type EquipmentDocument = {
  id: string; kind: ScanMetadata["kind"] | "SOURCE_ARCHIVE"; label: string;
  observed_on: string | null; notes: string | null; mime_type: string | null;
  size_bytes: number; sha256: string; has_file: boolean;
  scan_status: "PENDING" | "CLEAN" | "REJECTED" | "UNKNOWN";
  created_at: string; created_by: { id: number; label: string } | null;
};

function documentMissing(): never {
  throw new HttpError(404, "METROLOGY_DOCUMENT_NOT_FOUND", "Document introuvable pour cet instrument.");
}

export async function assertEquipmentDocumentParent(actor: ged.GedActor, equipmentId: string) {
  await assertGedParentLinkWritable(actor.id, { entity_type: ENTITY_TYPE, entity_id: equipmentId });
}

function metadataOf(detail: GedDocumentDetail): ScanMetadata {
  try {
    const json = JSON.parse(detail.description ?? "");
    if (json?.schema === "metrology-scan/1") {
      const parsed = scanMetadataSchema.safeParse(json.values);
      if (parsed.success) return parsed.data;
    }
  } catch { /* Existing free-text descriptions remain visible as notes. */ }
  return { kind: "OTHER", notes: detail.description };
}

export function documentDto(detail: GedDocumentDetail): EquipmentDocument {
  const metadata = metadataOf(detail);
  const version = detail.current_version;
  const status = version?.antivirus.status;
  const scanStatus = status === "clean" ? "CLEAN"
    : status === "pending" ? "PENDING"
    : status === "infected" || status === "scan_failed" ? "REJECTED" : "UNKNOWN";
  return {
    id: detail.id, kind: metadata.kind, label: metadata.label ?? detail.title,
    observed_on: metadata.observed_on ?? null, notes: metadata.notes ?? null,
    mime_type: version?.mime_type ?? null, size_bytes: version?.size_bytes ?? 0,
    sha256: version?.sha256 ?? "", has_file: Boolean(version && scanStatus === "CLEAN" && version.antivirus.quarantine_status === "released"),
    scan_status: scanStatus, created_at: detail.created_at,
    created_by: version?.created_by ? { id: version.created_by.id, label: version.created_by.label } : null,
  };
}

async function getAttachedGedDocument(actor: ged.GedActor, equipmentId: string, documentId: string) {
  const detail = await ged.getDocument(actor, documentId);
  if (detail.class_key !== CLASS_KEY || detail.links.length !== 1 ||
    detail.links[0].entity_type !== ENTITY_TYPE || detail.links[0].entity_id !== equipmentId) documentMissing();
  return detail;
}

export async function listEquipmentDocuments(actor: ged.GedActor, equipmentId: string, page = 1, pageSize = 200) {
  assertMetrologyCapability(actor.role, "documents_read");
  await assertEquipmentDocumentParent(actor, equipmentId);
  const listed = await repoListEquipmentDocumentRefs(equipmentId, page, pageSize);
  const items: EquipmentDocument[] = [];
  for (const ref of listed.items) {
    if (ref.origin === "ged") {
      items.push(documentDto(await getAttachedGedDocument(actor, equipmentId, ref.id)));
      continue;
    }
    const source = await repoGetImportedEquipmentSource(equipmentId, ref.id);
    if (!source) documentMissing();
    const archive = /\.(?:xlsx|ods|zip)$/i.test(source.source_name);
    items.push({
      id: source.id, kind: archive ? "SOURCE_ARCHIVE" : "OTHER",
      label: path.posix.basename(source.source_name.split("\\").join("/")),
      observed_on: null, notes: "Document repris du dossier Métrologie.",
      mime_type: source.mime_type, size_bytes: Number(source.size_bytes), sha256: source.sha256,
      scan_status: source.av_status === "CLEAN" ? "CLEAN" : source.av_status === "PENDING" ? "PENDING" : "REJECTED",
      has_file: source.av_status === "CLEAN", created_at: source.created_at, created_by: null,
    });
  }
  return { items, total: listed.total, page, page_size: pageSize, has_more: page * pageSize < listed.total };
}

export async function uploadEquipmentDocument(
  actor: ged.GedActor, equipmentId: string, metadata: ScanMetadata, file: Express.Multer.File | undefined,
) {
  assertMetrologyCapability(actor.role, "documents_write");
  await assertEquipmentDocumentParent(actor, equipmentId);
  if (!file) throw new HttpError(400, "FILE_REQUIRED", "Sélectionnez un PDF ou une photo.");
  const extension = path.extname(file.originalname).toLowerCase();
  const types: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
  if (!types[extension] || file.mimetype !== types[extension]) {
    throw new HttpError(400, "METROLOGY_SCAN_TYPE", "Seuls les PDF et photos JPEG/PNG sont acceptés.");
  }
  const detail = await ged.uploadDocument(actor, {
    class_key: CLASS_KEY,
    title: metadata.label ?? path.basename(file.originalname),
    description: JSON.stringify({ schema: "metrology-scan/1", values: metadata }),
    link: { entity_type: ENTITY_TYPE, entity_id: equipmentId, link_role: metadata.kind },
  }, file);
  return documentDto(detail);
}

export async function getEquipmentDocumentContent(actor: ged.GedActor, equipmentId: string, documentId: string) {
  assertMetrologyCapability(actor.role, "documents_read");
  await assertEquipmentDocumentParent(actor, equipmentId);
  const source = await repoGetImportedEquipmentSource(equipmentId, documentId);
  if (source) {
    if (source.av_status !== "CLEAN") throw new HttpError(409, "METROLOGY_SOURCE_SCAN_REQUIRED", "L'analyse du document n'est pas validée.");
    return { kind: "source" as const, source };
  }
  const detail = await getAttachedGedDocument(actor, equipmentId, documentId);
  if (!detail.current_version) documentMissing();
  if (detail.current_version.antivirus.status !== "clean" || detail.current_version.antivirus.quarantine_status !== "released") {
    throw new HttpError(409, "GED_SCAN_REQUIRED", "L'analyse du document n'est pas validée.");
  }
  return { kind: "ged" as const, content: await ged.downloadVersion(actor, detail.current_version.id) };
}
