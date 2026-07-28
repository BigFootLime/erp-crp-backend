// GED centrale CERP (ADR-0037) — contrôle de contenu.
//
// Reprend le motif éprouvé de `project-office-registers.service.ts` :
// un fichier n'est accepté que si son MIME, son extension ET sa signature
// binaire concordent. Un exécutable renommé en `.pdf` est refusé ici, pas
// découvert plus tard sur le poste de quelqu'un.
//
// Aucune I/O : ces fonctions travaillent sur un buffer déjà en mémoire.

import { HttpError } from "../../../utils/httpError";
import { fileExtension, sanitizeOriginalName } from "./ged-policy";

export type GedFileKind =
  | "pdf"
  | "png"
  | "jpeg"
  | "webp"
  | "tiff"
  | "docx"
  | "xlsx"
  | "pptx"
  | "csv"
  | "text"
  | "binary";

export type GedClassContentRules = {
  class_key: string;
  allowed_mime_types: readonly string[];
  allowed_extensions: readonly string[];
  max_size_bytes: number;
};

/* -------------------------------------------------------------------------- */
/* Formats refusés par construction                                           */
/* -------------------------------------------------------------------------- */

// Ces extensions ne sont jamais acceptables dans un coffre documentaire, même
// si une classe les autorisait par erreur de configuration. La liste est une
// seconde barrière : la première reste l'allowlist de la classe.
const ALWAYS_REJECTED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe", ".dll", ".com", ".bat", ".cmd", ".scr", ".pif", ".msi", ".msp",
  ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta",
  ".jar", ".sh", ".bash", ".app", ".apk", ".deb", ".rpm",
  // Formats Office à macros : le contenu actif n'a pas sa place ici.
  ".docm", ".xlsm", ".pptm", ".dotm", ".xltm", ".potm",
  // Le SVG peut porter du script : accepté en amont uniquement après
  // réencodage raster, jamais stocké comme original servable.
  ".svg", ".svgz",
  // Raccourcis et conteneurs qui masquent leur cible réelle.
  ".lnk", ".url", ".iso", ".img",
]);

export function isAlwaysRejectedExtension(extension: string): boolean {
  return ALWAYS_REJECTED_EXTENSIONS.has(extension.toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* Signatures binaires                                                        */
/* -------------------------------------------------------------------------- */

function startsWith(buffer: Buffer, ...bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function hasZipMagic(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    ((buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) ||
      (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x05 && buffer[3] === 0x06))
  );
}

function hasOoxmlPackageEntries(buffer: Buffer, expectedFolder: string): boolean {
  const probe = buffer.toString("latin1");
  return probe.includes("[Content_Types].xml") && probe.includes(expectedFolder);
}

/**
 * Vrai si le buffer ne contient aucun octet nul sur sa fenêtre d'inspection.
 * Un fichier texte (programme CN, CSV, post-processeur) n'en contient pas ;
 * un binaire déguisé en `.txt`, oui.
 */
function looksLikeText(buffer: Buffer): boolean {
  const window = buffer.subarray(0, Math.min(buffer.length, 64 * 1024));
  for (const byte of window) {
    if (byte === 0x00) return false;
  }
  return true;
}

const KIND_BY_EXTENSION: Readonly<Record<string, GedFileKind>> = {
  ".pdf": "pdf",
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
  ".tif": "tiff",
  ".tiff": "tiff",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
  ".csv": "csv",
  ".txt": "text",
  // Formats métier sans signature normalisée : contrôlés comme texte ou
  // binaire opaque, jamais interprétés.
  ".nc": "text",
  ".tap": "text",
  ".h": "text",
  ".mpf": "text",
  ".pst": "text",
  ".step": "text",
  ".stp": "text",
  ".iges": "text",
  ".igs": "text",
  ".stl": "binary",
  ".mcam": "binary",
  ".mcx": "binary",
  ".dwg": "binary",
  ".dxf": "binary",
};

export function fileKindForExtension(extension: string): GedFileKind | null {
  return KIND_BY_EXTENSION[extension.toLowerCase()] ?? null;
}

export function hasValidSignature(buffer: Buffer, kind: GedFileKind): boolean {
  switch (kind) {
    case "pdf":
      return startsWith(buffer, 0x25, 0x50, 0x44, 0x46, 0x2d);
    case "png":
      return startsWith(buffer, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "jpeg":
      return startsWith(buffer, 0xff, 0xd8, 0xff);
    case "webp":
      return (
        startsWith(buffer, 0x52, 0x49, 0x46, 0x46) &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
      );
    case "tiff":
      return startsWith(buffer, 0x49, 0x49, 0x2a, 0x00) || startsWith(buffer, 0x4d, 0x4d, 0x00, 0x2a);
    case "docx":
      return hasZipMagic(buffer) && hasOoxmlPackageEntries(buffer, "word/");
    case "xlsx":
      return hasZipMagic(buffer) && hasOoxmlPackageEntries(buffer, "xl/");
    case "pptx":
      return hasZipMagic(buffer) && hasOoxmlPackageEntries(buffer, "ppt/");
    case "csv":
    case "text":
      return looksLikeText(buffer);
    case "binary":
      // Aucune signature normalisée. On refuse au moins les formats exécutables
      // évidents déguisés en fichier métier.
      return !startsWith(buffer, 0x4d, 0x5a) && !startsWith(buffer, 0x7f, 0x45, 0x4c, 0x46);
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Contrôle complet                                                           */
/* -------------------------------------------------------------------------- */

export type AcceptedGedFile = {
  buffer: Buffer;
  sanitized_name: string;
  extension: string;
  mime_type: string;
  size_bytes: number;
  kind: GedFileKind;
};

/**
 * Contrôle complet d'un fichier déposé, dans l'ordre du moins cher au plus cher :
 * présence, taille, extension interdite, allowlist de classe, puis signature.
 */
export function assertAcceptedFile(
  file: { buffer?: Buffer; originalname?: string; mimetype?: string; size?: number } | undefined,
  rules: GedClassContentRules
): AcceptedGedFile {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new HttpError(400, "GED_FILE_REQUIRED", "Un fichier est requis.");
  }

  const size = file.size ?? file.buffer.byteLength;
  if (size <= 0) {
    throw new HttpError(400, "GED_FILE_REQUIRED", "Le fichier est vide.");
  }
  if (size > rules.max_size_bytes) {
    const maxMo = Math.floor(rules.max_size_bytes / (1024 * 1024));
    throw new HttpError(
      413,
      "GED_FILE_SIZE",
      `Le fichier dépasse la taille autorisée pour cette classe (${maxMo} Mo).`
    );
  }

  const sanitizedName = sanitizeOriginalName(file.originalname);
  const extension = fileExtension(sanitizedName);

  if (!extension) {
    throw new HttpError(415, "GED_FILE_TYPE", "Le fichier doit porter une extension reconnue.");
  }
  if (isAlwaysRejectedExtension(extension)) {
    throw new HttpError(
      415,
      "GED_FILE_TYPE",
      `L'extension ${extension} n'est jamais acceptée dans le coffre documentaire.`
    );
  }
  if (!rules.allowed_extensions.includes(extension)) {
    throw new HttpError(
      415,
      "GED_FILE_TYPE",
      `L'extension ${extension} n'est pas autorisée pour la classe ${rules.class_key}.`
    );
  }

  const mimeType = (file.mimetype ?? "").trim().toLowerCase() || "application/octet-stream";
  if (!rules.allowed_mime_types.includes(mimeType)) {
    throw new HttpError(
      415,
      "GED_FILE_TYPE",
      `Le type ${mimeType} n'est pas autorisé pour la classe ${rules.class_key}.`
    );
  }

  const kind = fileKindForExtension(extension);
  if (!kind) {
    throw new HttpError(415, "GED_FILE_TYPE", "Type de fichier non reconnu par la GED.");
  }
  if (!hasValidSignature(file.buffer, kind)) {
    throw new HttpError(
      415,
      "GED_FILE_SIGNATURE",
      "La signature binaire du fichier ne correspond pas au type annoncé."
    );
  }

  return {
    buffer: file.buffer,
    sanitized_name: sanitizedName,
    extension,
    mime_type: mimeType,
    size_bytes: size,
    kind,
  };
}
