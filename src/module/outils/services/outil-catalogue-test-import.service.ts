import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  cleanupSecureBufferDestination,
  ensurePrivateUploadDirectory,
  releaseSecureBufferDestination,
  validateSecureUploadBuffer,
  writeSecureBufferToDestination,
  type SecureBufferDestinationOwnership,
} from "../../../shared/uploads/secure-upload";
import { getTmpStoragePath, isPathInsideDirectory } from "../../../utils/cerpStorage";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { ensureCatalogueTestMaintenanceActor } from "../../auth/repository/catalogue-test-maintenance-actor.repository";
import { outilCatalogueImportRepository } from "../repository/outil-catalogue-import.repository";
import type { CatalogueSourceProvenance } from "./outil-catalogue.service";

type JsonObject = Record<string, unknown>;

export type QualifiedCatalogueRecord = Readonly<{
  manufacturer: string;
  family: string;
  geometry?: string | null;
  reference: string;
  designation?: string | null;
  codification?: string | null;
  dimensions?: JsonObject;
  toolMaterial?: string | null;
  coating?: string | null;
  matiere_usiner?: string | null;
  utilisation?: string | null;
  sourceSpecifications?: JsonObject;
  source: Readonly<{
    document: string;
    sha256: string;
    page: number;
    rect: readonly number[];
    selectionId?: string;
    selectionAnchorId?: string;
  }>;
  sourceSelectionId?: string;
  stock?: Readonly<{ state?: string; quantity?: number | null }>;
}>;

export type ImportPlanItem = Readonly<{
  index: number;
  record: QualifiedCatalogueRecord;
  source: CatalogueSourceProvenance;
  codification: string;
  designation: string;
  utilisation: string | null;
  sourceSpecifications: JsonObject | undefined;
  media: JsonObject;
}>;

export type QualifiedCatalogueImportReport = Readonly<{
  database: string;
  dryRun: boolean;
  created: number;
  replayed: number;
  rejected: ReadonlyArray<{ index: number; reference: string | null; reason: string }>;
}>;

const DIMENSION_KEYS = new Set([
  "longueur_coupe", "longueur_detalonnee", "longueur_totale", "diametre_nominal",
  "diametre_queue", "diametre_trou", "diametre_detalonnee", "angle_helice",
  "angle_pointe", "angle_filetage", "pas_filetage", "nombre_dents",
]);
const STRING_KEYS = new Set(["profondeur_utile", "matiere_usiner", "norme_filetage", "type_arrosage", "type_entree"]);

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(422, "CATALOGUE_IMPORT_RECORD_INVALID", `${name} requis`);
  return value.trim();
}
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function selectionId(record: QualifiedCatalogueRecord): string {
  const direct = optionalString(record.source.selectionId) ?? optionalString(record.source.selectionAnchorId) ?? optionalString(record.sourceSelectionId);
  if (direct && /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(direct)) return direct;
  // The identifier names a source row in this import, never a supplier SKU.
  const stable = crypto.createHash("sha256").update(`${record.source.sha256}:${record.source.page}:${record.reference}`).digest("hex").slice(0, 40);
  return `qualified-${stable}`;
}
function sourceFor(record: QualifiedCatalogueRecord): CatalogueSourceProvenance {
  const document = stringField(record.source?.document, "source.document");
  const sha256 = stringField(record.source?.sha256, "source.sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new HttpError(422, "CATALOGUE_IMPORT_RECORD_INVALID", "source.sha256 invalide");
  if (!Number.isInteger(record.source?.page) || record.source.page < 1) throw new HttpError(422, "CATALOGUE_IMPORT_RECORD_INVALID", "source.page invalide");
  const rect = record.source?.rect;
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new HttpError(422, "CATALOGUE_IMPORT_SOURCE_RECT_REQUIRED", "Les coordonnÃ©es source exactes sont requises pour la provenance.");
  }
  return { selectionId: selectionId(record), document, sha256, page: record.source.page, rect: [...rect] };
}
function normalizedDimensions(record: QualifiedCatalogueRecord): Record<string, string | number | null> {
  const dimensions = object(record.dimensions);
  const result: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(dimensions)) {
    if (DIMENSION_KEYS.has(key)) {
      if (value === null || value === undefined) result[key] = null;
      else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
      else throw new HttpError(422, "CATALOGUE_IMPORT_RECORD_INVALID", `Dimension ${key} invalide`);
    }
    if (STRING_KEYS.has(key)) result[key] = optionalString(value);
  }
  return result;
}
function utilisationFor(record: QualifiedCatalogueRecord): string | null {
  const usage = optionalString(record.utilisation);
  const coating = optionalString(record.coating);
  if (!usage) return coating ? `Revêtement : ${coating}` : null;
  if (!coating || usage.toLocaleLowerCase("fr-FR").includes(coating.toLocaleLowerCase("fr-FR"))) return usage;
  return `${usage} · Revêtement : ${coating}`;
}
function sourceSpecificationsFor(record: QualifiedCatalogueRecord): JsonObject | undefined {
  const facts = object(record.sourceSpecifications);
  return Object.keys(facts).length ? facts : undefined;
}

/** Parse one independently verified catalogue row without fabricating stock, price or source facts. */
export function planQualifiedCatalogueRecord(record: QualifiedCatalogueRecord, index = 0): ImportPlanItem {
  const manufacturer = stringField(record.manufacturer, "manufacturer");
  const family = stringField(record.family, "family");
  const reference = stringField(record.reference, "reference");
  if (!record.stock || record.stock.state !== "pending_inventory" || record.stock.quantity !== null) {
    throw new HttpError(422, "CATALOGUE_IMPORT_INVENTORY_REQUIRED", "Une fiche catalogue doit rester en attente dâ€™inventaire avec quantitÃ© inconnue.");
  }
  const source = sourceFor(record);
  // Validate every mapped numeric field during dry-run, before any actor or
  // taxonomy write can occur.
  normalizedDimensions(record);
  return {
    index,
    record: { ...record, manufacturer, family, reference, geometry: optionalString(record.geometry) },
    source,
    codification: optionalString(record.codification) ?? `${manufacturer} ${reference}`,
    designation: optionalString(record.designation) ?? `${family} ${reference}`,
    utilisation: utilisationFor(record),
    sourceSpecifications: sourceSpecificationsFor(record),
    media: object((record as unknown as JsonObject).media ?? (record as unknown as JsonObject).catalogueMedia),
  };
}

type TrustedImportMedia = Readonly<{
  files: { image?: Express.Multer.File; esquisse?: Express.Multer.File };
  ownerships: readonly SecureBufferDestinationOwnership[];
}>;

const MEDIA_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
function mediaDescriptor(value: unknown): { file: string; sha256?: string } | null {
  const record = object(value);
  const file = optionalString(record.file) ?? optionalString(record.path);
  if (!file) return null;
  const sha256 = optionalString(record.sha256);
  return { file, ...(sha256 ? { sha256 } : {}) };
}
async function trustedImportMedia(media: JsonObject): Promise<TrustedImportMedia> {
  const candidates: Array<["image" | "esquisse", { file: string; sha256?: string }]> = [
    ["image", mediaDescriptor(media.image)], ["esquisse", mediaDescriptor(media.sketch)],
  ].filter((entry): entry is ["image" | "esquisse", { file: string; sha256?: string }] => entry[1] !== null);
  if (!candidates.length) return { files: {}, ownerships: [] };
  const configuredRoot = process.env.CERP_TOOL_CATALOGUE_IMPORT_MEDIA_ROOT?.trim();
  if (!configuredRoot) throw new HttpError(503, "CATALOGUE_IMPORT_MEDIA_ROOT_REQUIRED", "Le répertoire privé des médias qualifiés est requis.");
  const root = await fs.realpath(path.resolve(configuredRoot));
  const files: { image?: Express.Multer.File; esquisse?: Express.Multer.File } = {};
  const ownerships: SecureBufferDestinationOwnership[] = [];
  try {
    for (const [field, descriptor] of candidates) {
      const filename = path.basename(descriptor.file);
      if (filename !== descriptor.file.replace(/\\/g, "/").split("/").pop() || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|webp)$/i.test(filename)) {
        throw new HttpError(422, "CATALOGUE_IMPORT_MEDIA_INVALID", "Nom de média qualifié invalide.");
      }
      const candidate = path.resolve(root, filename);
      if (!isPathInsideDirectory(root, candidate)) throw new HttpError(422, "CATALOGUE_IMPORT_MEDIA_INVALID", "Média hors du répertoire qualifié.");
      const info = await fs.lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 25 * 1024 * 1024) throw new HttpError(422, "CATALOGUE_IMPORT_MEDIA_INVALID", "Média qualifié indisponible.");
      const bytes = await fs.readFile(candidate);
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (!descriptor.sha256 || !/^[a-f0-9]{64}$/i.test(descriptor.sha256) || actual !== descriptor.sha256.toLowerCase()) {
        throw new HttpError(422, "CATALOGUE_IMPORT_MEDIA_HASH_MISMATCH", "Le hash du média qualifié ne correspond pas.");
      }
      const ext = path.extname(filename).toLowerCase();
      const upload = await validateSecureUploadBuffer("tool-media", bytes, filename, MEDIA_MIME[ext] ?? "application/octet-stream", new AbortController().signal);
      const tmpRoot = getTmpStoragePath();
      const stagingRoot = path.resolve(tmpRoot, "catalogue-import");
      ensurePrivateUploadDirectory(stagingRoot, tmpRoot);
      const staging = path.resolve(stagingRoot, `${crypto.randomUUID()}-${filename}`);
      const ownership = await writeSecureBufferToDestination(bytes, staging);
      upload.path = staging;
      upload.destination = path.dirname(staging);
      upload.filename = path.basename(staging);
      files[field] = upload;
      ownerships.push(ownership);
    }
    return { files, ownerships };
  } catch (error) {
    await Promise.allSettled(ownerships.map((ownership) => cleanupSecureBufferDestination(ownership)));
    throw error;
  }
}

export async function loadQualifiedCatalogueDataset(datasetPath: string): Promise<QualifiedCatalogueRecord[]> {
  const parsed: unknown = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  const records = object(parsed).records;
  if (!Array.isArray(records)) throw new HttpError(422, "CATALOGUE_IMPORT_DATASET_INVALID", "Le jeu qualifiÃ© doit contenir records[].");
  return records as QualifiedCatalogueRecord[];
}

export async function importQualifiedCatalogueTestOnly(records: readonly QualifiedCatalogueRecord[], apply: boolean): Promise<QualifiedCatalogueImportReport> {
  const databaseResult = await db.query<{ database: string }>("SELECT current_database() AS database");
  const database = databaseResult.rows[0]?.database ?? "";
  if (database !== "cerp_test") throw new HttpError(403, "CATALOGUE_IMPORT_TEST_DATABASE_REQUIRED", "Lâ€™import catalogue est rÃ©servÃ© Ã  cerp_test.");

  if (apply) await outilCatalogueImportRepository.assertImportSchema(db);

  const rejected: Array<{ index: number; reference: string | null; reason: string }> = [];
  const plans: ImportPlanItem[] = [];
  records.forEach((record, index) => {
    try { plans.push(planQualifiedCatalogueRecord(record, index)); }
    catch (error) { rejected.push({ index, reference: optionalString(record?.reference), reason: error instanceof Error ? error.message : "Ligne invalide" }); }
  });
  if (!apply) return { database, dryRun: true, created: 0, replayed: 0, rejected };
  if (rejected.length) {
    throw new HttpError(422, "CATALOGUE_IMPORT_REJECTED", `${rejected.length} ligne(s) doivent être corrigées avant apply.`);
  }

  const actor = await ensureCatalogueTestMaintenanceActor();
  // Loading the upload pipeline only for an explicit apply keeps dry-run usable
  // on operator hosts that deliberately do not mount upload storage.
  const { outilService } = await import("./outil.service");
  let created = 0;
  let replayed = 0;
  for (const plan of plans) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await outilCatalogueImportRepository.assertTestDatabase(client);
      const taxonomy = await outilCatalogueImportRepository.resolveTaxonomy(client, plan.record.manufacturer, plan.record.family, plan.record.geometry ?? null, optionalString(plan.record.coating));
      await client.query("COMMIT");
      await outilCatalogueImportRepository.advisoryImportLock(client, plan.record.manufacturer, plan.record.reference, plan.source.selectionId);
      const existing = await outilCatalogueImportRepository.findExisting(client, taxonomy.manufacturerId, plan.record.reference, plan.source.selectionId);
      if (existing) { replayed++; continue; }
      const dimensions = normalizedDimensions(plan.record);
      const importedMedia = await trustedImportMedia(plan.media);
      try {
      await outilService.createOutil({
        id_fabricant: taxonomy.manufacturerId,
        id_famille: taxonomy.familyId,
        id_geometrie: taxonomy.geometryId,
        codification: plan.codification,
        designation_outil_cnc: plan.designation,
        reference_fabricant: plan.record.reference,
        matiere_usiner: optionalString(plan.record.matiere_usiner) ?? (typeof plan.record.dimensions?.matiere_usiner === "string" ? optionalString(plan.record.dimensions.matiere_usiner) : null),
        utilisation: plan.utilisation,
        stock_initial_reason: "catalogue_pending_inventory",
        stock_initial_note: undefined,
        _created_at: undefined,
        quantite_stock: 0,
        quantite_minimale: 0,
        catalogue_source: { selection_id: plan.source.selectionId, reference_confirmed: true },
        fournisseurs: [], revetements: taxonomy.revetementId ? [taxonomy.revetementId] : [], prix_fournisseurs: [], valeurs_aretes: [],
        utilisateur: actor.username, user_id: actor.id,
        ...dimensions,
      }, importedMedia.files, { catalogueSourceOverride: plan.source, sourceSpecifications: plan.sourceSpecifications });
      created++;
      importedMedia.ownerships.forEach(releaseSecureBufferDestination);
      } catch (error) {
        await Promise.allSettled(importedMedia.ownerships.map((ownership) => cleanupSecureBufferDestination(ownership)));
        throw error;
      }
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* the creation service owns its transaction */ }
      rejected.push({ index: plan.index, reference: plan.record.reference, reason: error instanceof Error ? error.message : "Erreur import" });
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`catalogue-import:${plan.record.manufacturer}:${plan.record.reference}:${plan.source.selectionId}`]); } catch { /* connection release clears session locks */ }
      client.release();
    }
  }
  return { database, dryRun: false, created, replayed, rejected };
}

export function resolveQualifiedDatasetPath(candidate: string): string {
  if (!path.isAbsolute(candidate)) throw new HttpError(422, "CATALOGUE_IMPORT_DATASET_INVALID", "Le chemin du jeu qualifiÃ© doit Ãªtre absolu.");
  return path.resolve(candidate);
}
