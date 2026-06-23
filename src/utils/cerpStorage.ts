import fs from "fs";
import path from "path";

function clean(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function fallbackRoot() {
  return fs.existsSync("/srv/cerp") ? "/srv/cerp" : process.cwd();
}

export function getCerpRootPath(...segments: string[]) {
  const root = clean(process.env.CERP_ROOT) ?? fallbackRoot();
  return path.resolve(root, ...segments.filter(Boolean));
}

export function getStorageRootPath(...segments: string[]) {
  const root = clean(process.env.CERP_STORAGE_ROOT) ?? getCerpRootPath("data");
  return path.resolve(root, ...segments.filter(Boolean));
}

export function getDocumentsRootPath(...segments: string[]) {
  const root = clean(process.env.CERP_DOCUMENTS_ROOT) ?? getStorageRootPath("documents");
  return path.resolve(root, ...segments.filter(Boolean));
}

export function getGeneratedRootPath(...segments: string[]) {
  const root = clean(process.env.CERP_GENERATED_ROOT) ?? getStorageRootPath("generated");
  return path.resolve(root, ...segments.filter(Boolean));
}

export function getInboundRootPath(...segments: string[]) {
  const root = clean(process.env.CERP_INBOUND_ROOT) ?? getStorageRootPath("inbound");
  return path.resolve(root, ...segments.filter(Boolean));
}

export function getExportsRootPath(...segments: string[]) {
  const root = clean(process.env.CERP_EXPORTS_ROOT) ?? getStorageRootPath("exports");
  return path.resolve(root, ...segments.filter(Boolean));
}

export function getTmpRootPath(...segments: string[]) {
  const root = clean(process.env.CERP_TMP_ROOT) ?? getStorageRootPath("tmp");
  return path.resolve(root, ...segments.filter(Boolean));
}

export function getDocumentStoragePath(...segments: string[]) {
  return getDocumentsRootPath(...segments);
}

export function getTmpStoragePath(...segments: string[]) {
  return getTmpRootPath(...segments);
}

export function resolveCerpStoragePath(storagePath: string, fallbackBase?: string) {
  const trimmed = storagePath.trim();
  if (!trimmed) return path.resolve(fallbackBase ?? getCerpRootPath());

  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);

  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  const legacyMappings: Array<[string, string]> = [
    ["uploads/docs", getDocumentsRootPath()],
    ["uploads/tmp", getTmpRootPath()],
    ["uploads/images", getGeneratedRootPath("images")],
  ];

  for (const [legacyPrefix, targetRoot] of legacyMappings) {
    if (normalized === legacyPrefix) return targetRoot;
    if (normalized.startsWith(`${legacyPrefix}/`)) {
      return path.resolve(targetRoot, normalized.slice(legacyPrefix.length + 1));
    }
  }

  return path.resolve(fallbackBase ?? getCerpRootPath(), normalized);
}

export function isPathInsideDirectory(baseDir: string, candidatePath: string) {
  const base = path.resolve(baseDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function ensureDirectory(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureDocumentsPath(...segments: string[]) {
  return ensureDirectory(getDocumentsRootPath(...segments));
}

export function ensureGeneratedPath(...segments: string[]) {
  return ensureDirectory(getGeneratedRootPath(...segments));
}

export function ensureTmpPath(...segments: string[]) {
  return ensureDirectory(getTmpRootPath(...segments));
}

export function ensureDocumentStoragePath(...segments: string[]) {
  return ensureDirectory(getDocumentStoragePath(...segments));
}

export function ensureTmpStoragePath(...segments: string[]) {
  return ensureDirectory(getTmpStoragePath(...segments));
}
