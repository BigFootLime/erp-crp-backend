const MIB = 1024 * 1024;

export type UploadUsage =
  | "business-document"
  | "technical-document"
  | "machine-document"
  | "quality-document"
  | "image"
  | "tool-media"
  | "import-tabular"
  | "ged-deferred"
  | "project-evidence-deferred"
  | "project-asset-image";

export type UploadPolicy = Readonly<{
  usage: UploadUsage;
  label: string;
  maxFileBytes: number;
  maxFiles: number;
  maxFields: number;
  maxFieldBytes: number;
  allowedExtensions: ReadonlySet<string> | null;
  deferContentValidation: boolean;
}>;

const BUSINESS_DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".txt",
  ".csv",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".odt",
  ".ods",
]);

const TECHNICAL_DOCUMENT_EXTENSIONS = new Set([
  ...BUSINESS_DOCUMENT_EXTENSIONS,
  ".tif",
  ".tiff",
  ".pptx",
  ".xml",
  ".json",
  ".zip",
  ".7z",
  ".stp",
  ".step",
  ".stl",
  ".dxf",
  ".dwg",
  ".igs",
  ".iges",
  ".3mf",
  ".sldprt",
  ".sldasm",
  ".x_t",
  ".x_b",
  ".ipt",
  ".iam",
  ".catpart",
  ".catproduct",
  ".ncp",
  ".nc",
  ".cnc",
  ".tap",
  ".h",
  ".mpf",
  ".gcode",
]);

const QUALITY_DOCUMENT_EXTENSIONS = new Set([
  ...BUSINESS_DOCUMENT_EXTENSIONS,
  ".tif",
  ".tiff",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const TOOL_MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ".pdf"]);
const IMPORT_EXTENSIONS = new Set([".csv", ".xlsx"]);

function policy(
  usage: UploadUsage,
  label: string,
  maxFileBytes: number,
  maxFiles: number,
  allowedExtensions: ReadonlySet<string> | null,
  deferContentValidation = false
): UploadPolicy {
  return Object.freeze({
    usage,
    label,
    maxFileBytes,
    maxFiles,
    maxFields: 20,
    maxFieldBytes: 1024 * 1024,
    allowedExtensions,
    deferContentValidation,
  });
}

/**
 * One transport policy per real CERP usage. Historical files are never
 * revalidated with this table at download time: it governs new bytes only.
 */
export const UPLOAD_POLICIES: Readonly<Record<UploadUsage, UploadPolicy>> = Object.freeze({
  "business-document": policy(
    "business-document",
    "document métier",
    25 * MIB,
    10,
    BUSINESS_DOCUMENT_EXTENSIONS
  ),
  "technical-document": policy(
    "technical-document",
    "document technique",
    25 * MIB,
    10,
    TECHNICAL_DOCUMENT_EXTENSIONS
  ),
  "machine-document": policy(
    "machine-document",
    "document machine",
    50 * MIB,
    1,
    TECHNICAL_DOCUMENT_EXTENSIONS
  ),
  "quality-document": policy(
    "quality-document",
    "document qualité",
    25 * MIB,
    10,
    QUALITY_DOCUMENT_EXTENSIONS
  ),
  image: policy("image", "image", 10 * MIB, 3, IMAGE_EXTENSIONS),
  "tool-media": policy("tool-media", "média outillage", 25 * MIB, 3, TOOL_MEDIA_EXTENSIONS),
  "import-tabular": policy("import-tabular", "fichier d’import", 25 * MIB, 1, IMPORT_EXTENSIONS),
  // GED and Project Office already apply a stricter class-specific validator.
  // The central layer still enforces name, non-empty body, transport bounds,
  // duplicate detection, quarantine lifecycle and scanner mode.
  "ged-deferred": policy("ged-deferred", "document GED", 512 * MIB, 1, null, true),
  "project-evidence-deferred": policy(
    "project-evidence-deferred",
    "preuve Project Office",
    25 * MIB,
    1,
    null,
    true
  ),
  "project-asset-image": policy(
    "project-asset-image",
    "capture Project Office",
    5 * MIB,
    1,
    new Set([".png", ".jpg", ".jpeg"])
  ),
});

export const MIME_TYPES_BY_EXTENSION: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  ".pdf": new Set(["application/pdf"]),
  ".png": new Set(["image/png"]),
  ".jpg": new Set(["image/jpeg", "image/jpg"]),
  ".jpeg": new Set(["image/jpeg", "image/jpg"]),
  ".webp": new Set(["image/webp"]),
  ".gif": new Set(["image/gif"]),
  ".tif": new Set(["image/tiff"]),
  ".tiff": new Set(["image/tiff"]),
  ".txt": new Set(["text/plain"]),
  ".csv": new Set(["text/csv", "text/plain", "application/vnd.ms-excel"]),
  ".doc": new Set(["application/msword", "application/octet-stream"]),
  ".docx": new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/octet-stream",
  ]),
  ".xls": new Set(["application/vnd.ms-excel", "application/octet-stream"]),
  ".xlsx": new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/zip",
    "application/octet-stream",
  ]),
  ".pptx": new Set([
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/zip",
    "application/octet-stream",
  ]),
  ".odt": new Set(["application/vnd.oasis.opendocument.text", "application/zip", "application/octet-stream"]),
  ".ods": new Set(["application/vnd.oasis.opendocument.spreadsheet", "application/zip", "application/octet-stream"]),
  ".xml": new Set(["application/xml", "text/xml", "text/plain"]),
  ".json": new Set(["application/json", "text/plain"]),
  ".zip": new Set(["application/zip", "application/x-zip-compressed"]),
  ".7z": new Set(["application/x-7z-compressed", "application/octet-stream"]),
  ".stp": new Set(["model/step", "application/step", "text/plain", "application/octet-stream"]),
  ".step": new Set(["model/step", "application/step", "text/plain", "application/octet-stream"]),
  ".stl": new Set(["model/stl", "application/sla", "text/plain", "application/octet-stream"]),
  ".dxf": new Set(["application/dxf", "image/vnd.dxf", "text/plain", "application/octet-stream"]),
  ".dwg": new Set(["image/vnd.dwg", "application/acad", "application/octet-stream"]),
  ".igs": new Set(["model/iges", "application/iges", "text/plain", "application/octet-stream"]),
  ".iges": new Set(["model/iges", "application/iges", "text/plain", "application/octet-stream"]),
  ".3mf": new Set(["model/3mf", "application/zip", "application/octet-stream"]),
  ".sldprt": new Set(["application/octet-stream"]),
  ".sldasm": new Set(["application/octet-stream"]),
  ".x_t": new Set(["application/octet-stream", "text/plain"]),
  ".x_b": new Set(["application/octet-stream"]),
  ".ipt": new Set(["application/octet-stream"]),
  ".iam": new Set(["application/octet-stream"]),
  ".catpart": new Set(["application/octet-stream"]),
  ".catproduct": new Set(["application/octet-stream"]),
  ".ncp": new Set(["text/plain", "application/octet-stream"]),
  ".nc": new Set(["text/plain", "application/octet-stream"]),
  ".cnc": new Set(["text/plain", "application/octet-stream"]),
  ".tap": new Set(["text/plain", "application/octet-stream"]),
  ".h": new Set(["text/plain", "application/octet-stream"]),
  ".mpf": new Set(["text/plain", "application/octet-stream"]),
  ".gcode": new Set(["text/plain", "application/octet-stream"]),
});

export function getUploadPolicy(usage: UploadUsage): UploadPolicy {
  return UPLOAD_POLICIES[usage];
}

export function formatUploadLimit(bytes: number): string {
  return `${Math.round(bytes / MIB)} Mo`;
}
