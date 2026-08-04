import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { Request, RequestHandler } from "express";
import multer from "multer";

import { ensureDirectory, ensureTmpStoragePath } from "../../utils/cerpStorage";
import { HttpError } from "../../utils/httpError";
import logger from "../../utils/logger";
import {
  MIME_TYPES_BY_EXTENSION,
  formatUploadLimit,
  getUploadPolicy,
  type UploadPolicy,
  type UploadUsage,
} from "./upload-policy";
import { scanUpload, type UploadScanStatus } from "./upload-scanner";

export type UploadSecurityMetadata = Readonly<{
  usage: UploadUsage;
  sha256: string;
  scanStatus: UploadScanStatus;
  scanProvider: string;
}>;

declare global {
  namespace Express {
    namespace Multer {
      interface File {
        uploadSecurity?: UploadSecurityMetadata;
      }
    }
  }
}

type SecureUploadStorage = "memory" | "staging" | Readonly<{ finalDirectory: string }>;

export type SecureUploadOptions = Readonly<{
  storage?: SecureUploadStorage;
  maxFiles?: number;
}>;

export type SecureUpload = Readonly<{
  single(fieldName: string): RequestHandler;
  array(fieldName: string, maxCount?: number): RequestHandler;
  fields(fields: readonly { name: string; maxCount?: number }[]): RequestHandler;
  any(): RequestHandler;
}>;

const SAMPLE_BYTES = 64 * 1024;
const WINDOWS_UNSAFE = /[:*?"<>|]/;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
export type UploadDestinationState =
  | "transferred"
  | "commit-attempted"
  | "committed"
  | "rolled-back"
  | "rollback-uncertain";
type UploadDestination = { destination: string; state: UploadDestinationState };
export type UploadFileReference = Readonly<{ path: string }>;
const uploadDestinations = new Map<string, Map<string, UploadDestination>>();

/**
 * Registers an application-managed destination created from an uploaded file.
 * Registration transfers ownership out of central staging. A response close
 * can happen after COMMIT (or after COMMIT was applied but its ACK was lost),
 * so the response lifecycle never deletes a registered destination.
 */
export function registerUploadDestination(file: Readonly<{ path: string }>, destination: string): void {
  const source = path.resolve(file.path);
  const resolved = path.resolve(destination);
  const destinations = uploadDestinations.get(source) ?? new Map<string, UploadDestination>();
  destinations.set(resolved, { destination: resolved, state: "transferred" });
  uploadDestinations.set(source, destinations);
}

function updateUploadDestinationState(
  files: readonly UploadFileReference[],
  state: UploadDestinationState
): void {
  for (const file of files) {
    const destinations = uploadDestinations.get(path.resolve(file.path));
    if (!destinations) continue;
    for (const record of destinations.values()) record.state = state;
  }
}

/** Call immediately before issuing COMMIT. From this point deletion is unsafe. */
export function markUploadCommitAttempted(files: readonly UploadFileReference[]): void {
  updateUploadDestinationState(files, "commit-attempted");
}

/** Call after a successful COMMIT or positive reconciliation on a fresh connection. */
export function markUploadsCommitted(files: readonly UploadFileReference[]): void {
  updateUploadDestinationState(files, "committed");
}

/** Mark ownership as indeterminate when a pre-COMMIT rollback could not be confirmed. */
export function markUploadRollbackUncertain(files: readonly UploadFileReference[]): void {
  updateUploadDestinationState(files, "rollback-uncertain");
}

/**
 * Delete transferred destinations only after the caller has proven that the
 * database transaction rolled back before COMMIT was attempted.
 */
async function cleanupOwnedDestinations(
  files: readonly UploadFileReference[],
  allowedStates: ReadonlySet<UploadDestinationState>
): Promise<void> {
  const removable: string[] = [];
  for (const file of files) {
    const destinations = uploadDestinations.get(path.resolve(file.path));
    if (!destinations) continue;
    for (const record of destinations.values()) {
      if (!allowedStates.has(record.state)) {
        logger.error("[UPLOAD_OWNERSHIP] refused unsafe cleanup", JSON.stringify({ state: record.state }));
        continue;
      }
      record.state = "rolled-back";
      removable.push(record.destination);
    }
  }
  await cleanupPaths(removable);
}

export async function cleanupUploadsAfterConfirmedRollback(files: readonly UploadFileReference[]): Promise<void> {
  await cleanupOwnedDestinations(files, new Set<UploadDestinationState>(["transferred"]));
}

/** Cleanup after a fresh connection proved that a previously attempted COMMIT was not applied. */
export async function cleanupUploadsAfterReconciledNoCommit(files: readonly UploadFileReference[]): Promise<void> {
  await cleanupOwnedDestinations(
    files,
    new Set<UploadDestinationState>(["transferred", "commit-attempted"])
  );
}

function releaseRegisteredUploadDestinations(files: readonly Express.Multer.File[]): UploadDestination[] {
  return files.flatMap((file) => {
    if (!file.path) return [];
    const source = path.resolve(file.path);
    const destinations = Array.from(uploadDestinations.get(source)?.values() ?? []);
    uploadDestinations.delete(source);
    return destinations;
  });
}

function auditUpload(
  req: Request,
  usage: UploadUsage,
  outcome: "accepted" | "rejected" | "cleaned",
  details: Record<string, unknown>
): void {
  logger.info(
    "[UPLOAD_AUDIT]",
    JSON.stringify({
      event: "security.upload",
      request_id: req.requestId ?? null,
      actor_id: req.user?.id ?? null,
      method: req.method,
      route: req.baseUrl + req.path,
      usage,
      outcome,
      ...details,
    })
  );
}

export function assertSafeUploadName(originalName: string): string {
  if (!originalName || originalName !== originalName.trim()) {
    throw new HttpError(400, "UPLOAD_NAME_INVALID", "Le nom du fichier est vide ou contient des espaces ambigus.");
  }
  if (Buffer.byteLength(originalName, "utf8") > 240) {
    throw new HttpError(400, "UPLOAD_NAME_TOO_LONG", "Le nom du fichier dépasse 240 octets. Renommez-le puis réessayez.");
  }
  if (
    CONTROL_OR_BIDI.test(originalName) ||
    WINDOWS_UNSAFE.test(originalName) ||
    originalName.includes("/") ||
    originalName.includes("\\") ||
    originalName === "." ||
    originalName === ".." ||
    path.basename(originalName) !== originalName
  ) {
    throw new HttpError(400, "UPLOAD_NAME_INVALID", "Le nom du fichier contient un chemin ou des caractères interdits. Renommez-le puis réessayez.");
  }
  return originalName.normalize("NFC");
}

function extensionOf(originalName: string): string {
  const extension = path.extname(originalName).toLowerCase();
  if (!/^\.[a-z0-9_]+$/.test(extension) || extension.length > 12) {
    throw new HttpError(415, "UPLOAD_EXTENSION_INVALID", "L’extension du fichier est absente ou invalide.");
  }
  return extension;
}

function normalizeMime(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function assertPreflight(file: Pick<Express.Multer.File, "originalname" | "mimetype">, policy: UploadPolicy): string | null {
  const name = assertSafeUploadName(file.originalname);
  if (policy.deferContentValidation) return null;
  const extension = extensionOf(name);
  if (!policy.allowedExtensions?.has(extension)) {
    throw new HttpError(415, "UPLOAD_EXTENSION_FORBIDDEN", `Ce format n’est pas autorisé pour un ${policy.label}.`);
  }
  const allowedMimes = MIME_TYPES_BY_EXTENSION[extension];
  if (!allowedMimes?.has(normalizeMime(file.mimetype))) {
    throw new HttpError(415, "UPLOAD_MIME_MISMATCH", "Le type déclaré du fichier ne correspond pas à son extension.");
  }
  return extension;
}

type FileSample = Readonly<{ head: Buffer; tail: Buffer }>;

async function sampleFile(file: Express.Multer.File): Promise<FileSample> {
  if (file.buffer) {
    return {
      head: file.buffer.subarray(0, SAMPLE_BYTES),
      tail: file.buffer.subarray(Math.max(0, file.buffer.length - SAMPLE_BYTES)),
    };
  }
  const handle = await fs.open(file.path, "r");
  try {
    const head = Buffer.alloc(Math.min(SAMPLE_BYTES, file.size));
    const tail = Buffer.alloc(Math.min(SAMPLE_BYTES, file.size));
    if (head.length) await handle.read(head, 0, head.length, 0);
    if (tail.length) await handle.read(tail, 0, tail.length, Math.max(0, file.size - tail.length));
    return { head, tail };
  } finally {
    await handle.close();
  }
}

function startsWith(buffer: Buffer, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => buffer[offset + index] === byte);
}

function containsAscii(sample: FileSample, text: string): boolean {
  return sample.head.includes(Buffer.from(text, "ascii")) || sample.tail.includes(Buffer.from(text, "ascii"));
}

function isProbablyText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  if (buffer.length === 0) return false;
  let controls = 0;
  for (const byte of buffer) {
    if (byte < 0x20 && ![0x09, 0x0a, 0x0d, 0x0c].includes(byte)) controls += 1;
  }
  return controls / buffer.length < 0.01;
}

function isForbiddenExecutable(head: Buffer): boolean {
  return (
    startsWith(head, [0x4d, 0x5a]) ||
    startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(head, [0xfe, 0xed, 0xfa, 0xcf])
  );
}

export function contentMatchesExtension(extension: string, sample: FileSample, size: number): boolean {
  const { head, tail } = sample;
  if (isForbiddenExecutable(head)) return false;

  switch (extension) {
    case ".pdf":
      return head.subarray(0, 5).toString("latin1") === "%PDF-" && tail.includes(Buffer.from("%%EOF", "ascii"));
    case ".png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case ".jpg":
    case ".jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]) && tail.subarray(Math.max(0, tail.length - 2)).equals(Buffer.from([0xff, 0xd9]));
    case ".gif":
      return head.subarray(0, 6).toString("ascii") === "GIF87a" || head.subarray(0, 6).toString("ascii") === "GIF89a";
    case ".webp":
      return head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP";
    case ".tif":
    case ".tiff":
      return startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a]);
    case ".doc":
    case ".xls":
      return startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case ".docx":
      return startsWith(head, [0x50, 0x4b]) && containsAscii(sample, "word/");
    case ".xlsx":
      return startsWith(head, [0x50, 0x4b]) && containsAscii(sample, "xl/");
    case ".pptx":
      return startsWith(head, [0x50, 0x4b]) && containsAscii(sample, "ppt/");
    case ".odt":
    case ".ods":
      return startsWith(head, [0x50, 0x4b]) && containsAscii(sample, "content.xml");
    case ".zip":
    case ".3mf":
      return startsWith(head, [0x50, 0x4b]);
    case ".7z":
      return startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    case ".stp":
    case ".step":
      return isProbablyText(head) && containsAscii(sample, "ISO-10303-21");
    case ".stl":
      return (isProbablyText(head) && head.subarray(0, 80).toString("ascii").trimStart().startsWith("solid")) || size >= 84;
    case ".dxf":
      return (isProbablyText(head) && containsAscii(sample, "SECTION")) || head.toString("ascii", 0, 22) === "AutoCAD Binary DXF\r\n\x1a\0";
    case ".dwg":
      return /^AC10\d{2}/.test(head.subarray(0, 6).toString("ascii"));
    case ".igs":
    case ".iges":
    case ".x_t":
    case ".ncp":
    case ".nc":
    case ".cnc":
    case ".tap":
    case ".h":
    case ".mpf":
    case ".gcode":
    case ".txt":
    case ".csv":
    case ".xml":
    case ".json":
      return isProbablyText(head);
    // Proprietary CAD containers have no stable public magic value. They are
    // accepted only with an octet-stream MIME and after executable rejection.
    case ".sldprt":
    case ".sldasm":
    case ".x_b":
    case ".ipt":
    case ".iam":
    case ".catpart":
    case ".catproduct":
      return true;
    default:
      return false;
  }
}

async function sha256(file: Express.Multer.File): Promise<string> {
  const hash = createHash("sha256");
  if (file.buffer) {
    hash.update(file.buffer);
    return hash.digest("hex");
  }
  const stream = createReadStream(file.path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function cleanupPaths(paths: Iterable<string>): Promise<void> {
  await Promise.all(Array.from(new Set(paths)).map((filePath) => fs.unlink(filePath).catch(() => undefined)));
}

function multerFiles(req: Request): Express.Multer.File[] {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === "object") return Object.values(req.files).flat();
  return [];
}

async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw error;
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await fs.unlink(source);
  }
}

/**
 * Promote one validated staging file into durable storage and transfer its
 * ownership to the transaction lifecycle. The file object is updated so both
 * transaction helpers and the response cleanup callback address the same key.
 */
export async function promoteSecureUpload(
  file: Express.Multer.File,
  finalDirectory: string,
  filename?: string
): Promise<string> {
  ensureDirectory(finalDirectory);
  const extension = path.extname(file.originalname).toLowerCase();
  const storedName = filename ?? `${randomUUID()}${extension}`;
  const destination = path.resolve(finalDirectory, storedName);
  await moveFile(path.resolve(file.path), destination);
  await fs.chmod(destination, 0o600).catch(() => undefined);
  file.destination = path.resolve(finalDirectory);
  file.filename = storedName;
  file.path = destination;
  registerUploadDestination(file, destination);
  return destination;
}

async function promoteFiles(files: Express.Multer.File[], finalDirectory: string): Promise<string[]> {
  ensureDirectory(finalDirectory);
  const promoted: string[] = [];
  try {
    for (const file of files) {
      const extension = path.extname(file.originalname).toLowerCase();
      const filename = `${randomUUID()}${extension}`;
      const destination = path.resolve(finalDirectory, filename);
      await moveFile(file.path, destination);
      await fs.chmod(destination, 0o600).catch(() => undefined);
      file.destination = path.resolve(finalDirectory);
      file.filename = filename;
      file.path = destination;
      promoted.push(destination);
    }
    return promoted;
  } catch (error) {
    await cleanupPaths(promoted);
    throw error;
  }
}

async function validateFiles(files: Express.Multer.File[], policy: UploadPolicy): Promise<void> {
  if (files.length > policy.maxFiles) {
    throw new HttpError(400, "UPLOAD_TOO_MANY_FILES", `Vous pouvez envoyer au maximum ${policy.maxFiles} fichier(s) à la fois.`);
  }
  const hashes = new Set<string>();
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new HttpError(400, "UPLOAD_EMPTY_FILE", "Le fichier est vide. Sélectionnez un fichier contenant des données.");
    }
    if (file.size > policy.maxFileBytes) {
      throw new HttpError(413, "UPLOAD_FILE_TOO_LARGE", `Le fichier dépasse la limite de ${formatUploadLimit(policy.maxFileBytes)}.`);
    }
    const extension = assertPreflight(file, policy);
    const sample = await sampleFile(file);
    if (isForbiddenExecutable(sample.head)) {
      throw new HttpError(415, "UPLOAD_EXECUTABLE_FORBIDDEN", "Les fichiers exécutables sont interdits.");
    }
    if (extension && !contentMatchesExtension(extension, sample, file.size)) {
      throw new HttpError(415, "UPLOAD_SIGNATURE_MISMATCH", "Le contenu du fichier ne correspond pas à son extension.");
    }
    const digest = await sha256(file);
    if (hashes.has(digest)) {
      throw new HttpError(409, "UPLOAD_DUPLICATE_FILE", "Le même fichier apparaît plusieurs fois dans cet envoi.");
    }
    hashes.add(digest);

    const scan = await scanUpload(file.buffer ? { buffer: file.buffer } : { path: file.path });
    if (scan.status === "infected") {
      throw new HttpError(422, "UPLOAD_SCAN_REJECTED", "Le fichier a été placé en quarantaine et refusé par le scanner de sécurité.");
    }
    if (scan.status === "unavailable" && scan.mode === "enforce") {
      throw new HttpError(503, "UPLOAD_SCAN_UNAVAILABLE", "Le contrôle antivirus est indisponible. Réessayez plus tard ou contactez l’administrateur.");
    }
    file.uploadSecurity = {
      usage: policy.usage,
      sha256: digest,
      scanStatus: scan.status,
      scanProvider: scan.provider,
    };
  }
}

function translateMulterError(error: unknown, policy: UploadPolicy): Error {
  if (!(error instanceof multer.MulterError)) return error instanceof Error ? error : new Error("Upload failure");
  switch (error.code) {
    case "LIMIT_FILE_SIZE":
      return new HttpError(413, "UPLOAD_FILE_TOO_LARGE", `Le fichier dépasse la limite de ${formatUploadLimit(policy.maxFileBytes)}.`);
    case "LIMIT_FILE_COUNT":
    case "LIMIT_UNEXPECTED_FILE":
      return new HttpError(400, "UPLOAD_TOO_MANY_FILES", `Le nombre de fichiers dépasse la limite autorisée (${policy.maxFiles}).`);
    case "LIMIT_FIELD_COUNT":
    case "LIMIT_FIELD_KEY":
    case "LIMIT_FIELD_VALUE":
      return new HttpError(400, "UPLOAD_FORM_INVALID", "Le formulaire d’envoi est trop volumineux ou contient trop de champs.");
    default:
      return new HttpError(400, "UPLOAD_INVALID", "Le fichier n’a pas pu être reçu. Vérifiez-le puis réessayez.");
  }
}

export function createSecureUpload(usage: UploadUsage, options: SecureUploadOptions = {}): SecureUpload {
  const basePolicy = getUploadPolicy(usage);
  const policy: UploadPolicy = options.maxFiles
    ? Object.freeze({ ...basePolicy, maxFiles: Math.min(options.maxFiles, basePolicy.maxFiles) })
    : basePolicy;
  const storage = options.storage ?? "staging";
  const isMemory = storage === "memory";
  const quarantineDirectory = isMemory ? null : ensureTmpStoragePath("upload-quarantine", usage);

  const makeMulter = (maxFiles: number) =>
    multer({
      storage: isMemory
        ? multer.memoryStorage()
        : multer.diskStorage({
            destination: quarantineDirectory!,
            filename: (_req, _file, callback) => callback(null, `${randomUUID()}.part`),
          }),
      preservePath: true,
      limits: {
        fileSize: policy.maxFileBytes,
        files: maxFiles,
        fields: policy.maxFields,
        fieldSize: policy.maxFieldBytes,
      },
      fileFilter: (_req, file, callback) => {
        try {
          assertPreflight(file, policy);
          callback(null, true);
        } catch (error) {
          callback(error as Error);
        }
      },
    });

  const wrap = (multerHandler: RequestHandler): RequestHandler => (req, res, next) => {
    multerHandler(req, res, async (uploadError?: unknown) => {
      const files = multerFiles(req);
      const stagedPaths = files.filter((file) => !!file.path).map((file) => file.path);
      let promotedPaths: string[] = [];
      let cleanupStarted = false;

      const cleanupAfterResponse = () => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        const ownership = releaseRegisteredUploadDestinations(files);
        const uncertain = ownership.filter((record) =>
          record.state === "transferred" ||
          record.state === "commit-attempted" ||
          record.state === "rollback-uncertain"
        );
        if (uncertain.length > 0 || (promotedPaths.length > 0 && (res.statusCode >= 400 || !res.writableEnded))) {
          logger.error("[UPLOAD_OWNERSHIP] durable destination preserved for reconciliation", JSON.stringify({
            state_counts: ownership.reduce<Record<string, number>>((counts, record) => {
              counts[record.state] = (counts[record.state] ?? 0) + 1;
              return counts;
            }, {}),
            central_promotions: promotedPaths.length,
            response_status: res.statusCode,
            response_ended: res.writableEnded,
          }));
        }
        // Response close/abort is never proof of a database rollback. Only
        // untransferred staging belongs to this lifecycle callback.
        void cleanupPaths(stagedPaths).then(() => {
          if (stagedPaths.length > 0) {
            auditUpload(req, usage, "cleaned", {
              staged_count: stagedPaths.length,
              promoted_count: 0,
            });
          }
        });
      };

      try {
        if (uploadError) throw translateMulterError(uploadError, policy);
        await validateFiles(files, policy);
        if (typeof storage === "object") {
          promotedPaths = await promoteFiles(files, storage.finalDirectory);
        } else if (!isMemory) {
          await Promise.all(files.map((file) => fs.chmod(file.path, 0o600).catch(() => undefined)));
        }
        if (files.length > 0) {
          res.once("finish", cleanupAfterResponse);
          res.once("close", cleanupAfterResponse);
        }
        auditUpload(req, usage, "accepted", {
          file_count: files.length,
          total_bytes: files.reduce((sum, file) => sum + file.size, 0),
          scan_statuses: Array.from(new Set(files.map((file) => file.uploadSecurity?.scanStatus ?? "unknown"))),
        });
        next();
      } catch (error) {
        await cleanupPaths([...stagedPaths, ...promotedPaths]);
        auditUpload(req, usage, "rejected", {
          code: error instanceof HttpError ? error.code : "UPLOAD_INTERNAL_ERROR",
          file_count: files.length,
        });
        next(error);
      }
    });
  };

  return {
    single: (fieldName) => wrap(makeMulter(1).single(fieldName)),
    array: (fieldName, maxCount = policy.maxFiles) => {
      const effective = Math.min(maxCount, policy.maxFiles);
      return wrap(makeMulter(effective).array(fieldName, effective));
    },
    fields: (fields) => {
      const maxFiles = Math.min(
        fields.reduce((sum, field) => sum + (field.maxCount ?? 1), 0),
        policy.maxFiles
      );
      return wrap(makeMulter(maxFiles).fields(fields.map((field) => ({ ...field }))));
    },
    any: () => wrap(makeMulter(policy.maxFiles).any()),
  };
}
