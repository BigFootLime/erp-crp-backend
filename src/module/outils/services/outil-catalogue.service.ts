import { promises as fs } from "node:fs";
import path from "node:path";

import { HttpError } from "../../../utils/httpError";

const ASSET_URL_PREFIX = "/outils/catalogue/assets/";
const LEGACY_ASSET_URL_PREFIX = "/tooling/catalogues/";
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

type CatalogueRecord = Record<string, unknown>;

export type CatalogueSourceProvenance = {
  selectionId: string;
  document: string;
  sha256: string;
  page: number;
  rect: number[];
};

function unavailable(): HttpError {
  return new HttpError(503, "OUTILLAGE_CATALOGUE_UNAVAILABLE", "Le catalogue outillage est momentanément indisponible.");
}

function assetName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const prefix = value.startsWith(LEGACY_ASSET_URL_PREFIX)
    ? LEGACY_ASSET_URL_PREFIX
    : value.startsWith(ASSET_URL_PREFIX)
      ? ASSET_URL_PREFIX
      : null;
  if (!prefix) return null;
  const name = value.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|png|webp)$/.test(name)) return null;
  return name;
}

function requireAssetName(value: unknown): string {
  const name = assetName(value);
  if (!name) throw unavailable();
  return name;
}

async function resolveCatalogueRoot(): Promise<string> {
  const configured = process.env.CERP_TOOL_CATALOGUE_ROOT?.trim();
  const requested = configured
    ? path.resolve(configured)
    : getDefaultToolCatalogueRoot();
  try {
    const info = await fs.stat(requested);
    if (!info.isDirectory()) throw unavailable();
    return await fs.realpath(requested);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function readManifest(): Promise<{ root: string; bundle: CatalogueRecord; assetNames: Set<string> }> {
  const root = await resolveCatalogueRoot();
  const manifestPath = path.resolve(root, "selection-jmt.json");
  if (!inside(root, manifestPath)) throw unavailable();

  try {
    const manifestInfo = await fs.lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MAX_MANIFEST_BYTES) throw unavailable();
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable();
    const bundle = parsed as CatalogueRecord;
    if (!Array.isArray(bundle.entries)) throw unavailable();

    const assetNames = new Set<string>();
    const entries = bundle.entries.map((rawEntry) => {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) throw unavailable();
      const entry = { ...(rawEntry as CatalogueRecord) };
      const rewrite = (container: CatalogueRecord, key: string) => {
        const value = container[key];
        if (value === null || typeof value === "undefined") return;
        const name = requireAssetName(value);
        assetNames.add(name);
        container[key] = `${ASSET_URL_PREFIX}${name}`;
      };
      rewrite(entry, "imageUrl");
      rewrite(entry, "sketchUrl");
      if (!entry.source || typeof entry.source !== "object" || Array.isArray(entry.source)) throw unavailable();
      entry.source = { ...(entry.source as CatalogueRecord) };
      rewrite(entry.source as CatalogueRecord, "previewUrl");
      rewrite(entry.source as CatalogueRecord, "cropUrl");
      return entry;
    });

    return { root, bundle: { ...bundle, entries }, assetNames };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}

export async function getToolCatalogueBundle(): Promise<CatalogueRecord> {
  const { bundle } = await readManifest();
  return bundle;
}

/** Resolve provenance from the private manifest; callers never submit source metadata. */
export async function getToolCatalogueSourceProvenance(selectionId: string): Promise<CatalogueSourceProvenance> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(selectionId)) {
    throw new HttpError(422, "OUTILLAGE_CATALOGUE_SELECTION_INVALID", "Sélection catalogue invalide");
  }
  const { bundle } = await readManifest();
  const entry = (bundle.entries as unknown[]).find((candidate) => (
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && (candidate as CatalogueRecord).id === selectionId
  )) as CatalogueRecord | undefined;
  const source = entry?.source;
  if (!entry || !source || typeof source !== "object" || Array.isArray(source)) {
    throw new HttpError(422, "OUTILLAGE_CATALOGUE_SELECTION_INVALID", "Sélection catalogue introuvable");
  }
  const record = source as CatalogueRecord;
  if (
    typeof record.document !== "string" || record.document.length < 1 || record.document.length > 500
    || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.sha256)
    || !Number.isInteger(record.page) || (record.page as number) < 1
    || !Array.isArray(record.rect) || record.rect.length !== 4 || !record.rect.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    throw unavailable();
  }
  return {
    selectionId,
    document: record.document,
    sha256: record.sha256.toLowerCase(),
    page: record.page as number,
    rect: record.rect as number[],
  };
}

export async function getToolCatalogueAsset(filename: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|png|webp)$/.test(filename)) {
    throw new HttpError(404, "OUTILLAGE_CATALOGUE_ASSET_NOT_FOUND", "Extrait catalogue introuvable");
  }
  const { root, assetNames } = await readManifest();
  if (!assetNames.has(filename)) {
    throw new HttpError(404, "OUTILLAGE_CATALOGUE_ASSET_NOT_FOUND", "Extrait catalogue introuvable");
  }
  const candidate = path.resolve(root, "assets", filename);
  const assetsRoot = path.resolve(root, "assets");
  if (!inside(assetsRoot, candidate)) throw new HttpError(404, "OUTILLAGE_CATALOGUE_ASSET_NOT_FOUND", "Extrait catalogue introuvable");

  try {
    const assetsInfo = await fs.lstat(assetsRoot);
    if (!assetsInfo.isDirectory() || assetsInfo.isSymbolicLink()) throw new Error("assets root is a link");
    const info = await fs.lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ASSET_BYTES) throw new Error("not a regular asset");
    const realCandidate = await fs.realpath(candidate);
    const realAssetsRoot = await fs.realpath(assetsRoot);
    if (!inside(root, realAssetsRoot) || !inside(realAssetsRoot, realCandidate)) throw new Error("asset escapes root");
    const extension = path.extname(filename).toLowerCase();
    const contentType = ASSET_CONTENT_TYPES[extension];
    if (!contentType) throw new Error("unsupported asset type");
    return { bytes: await fs.readFile(realCandidate), contentType };
  } catch {
    throw new HttpError(404, "OUTILLAGE_CATALOGUE_ASSET_NOT_FOUND", "Extrait catalogue introuvable");
  }
}

export function getDefaultToolCatalogueRoot(): string {
  // This module compiles to dist/module/outils/services. Four parents reach the
  // deployed API root in both source and compiled layouts, unlike process.cwd()
  // for isolated managed-test instances.
  return path.resolve(__dirname, "../../../../resources", "outillage-catalogue");
}
