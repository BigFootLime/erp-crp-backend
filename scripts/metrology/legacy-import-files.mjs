import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export function refuse(reason) {
  throw new Error("METROLOGY_IMPORT_REFUSED: " + reason);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function fileSha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export function relativeSourceName(value) {
  if (typeof value !== "string" || !value || value.includes("\0") ||
      /^[\\/]|^[A-Za-z]:/.test(value)) refuse("relative source path required");
  const parts = value.split(/[\\/]/);
  if (parts.some(part => !part || part === "." || part === "..")) refuse("source path traversal");
  return parts.join("/");
}

function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

/** Keep distinct source paths even when their contents are identical. */
export function businessSourceFiles(manifest) {
  if (!Array.isArray(manifest.sourceSet?.files) || !Array.isArray(manifest.attachments?.business)) {
    refuse("complete workbook and attachment inventory required");
  }
  const mime = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".pdf": "application/pdf", ".zip": "application/zip",
  };
  const files = [...manifest.sourceSet.files, ...manifest.attachments.business].map(source => {
    const name = relativeSourceName(source.relativePath ?? source.sourceRelativePath);
    const extension = path.posix.extname(name).toLowerCase();
    const size = source.sizeBytes ?? source.bytes;
    if (!mime[extension] || !Number.isSafeInteger(size) || size < 0 ||
        !/^[a-f0-9]{64}$/i.test(source.sha256 ?? "")) refuse("invalid business source descriptor");
    return { relativePath: name, sha256: source.sha256.toLowerCase(), sizeBytes: size, mimeType: mime[extension] };
  });
  const paths = new Set();
  for (const file of files) {
    if (paths.has(file.relativePath)) refuse("duplicate source path");
    paths.add(file.relativePath);
  }
  return files;
}

/** Real paths and every child component are checked; a link is never followed. */
export async function containedRegularFile(root, relative) {
  const name = relativeSourceName(relative);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) refuse("source root must be a real directory");
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const part of name.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) refuse("symbolic source links forbidden");
  }
  const canonical = await realpath(current);
  if (!within(canonicalRoot, canonical)) refuse("source escapes root");
  const info = await lstat(canonical);
  if (!info.isFile()) refuse("regular source file required");
  return { filename: canonical, sizeBytes: info.size };
}

export async function verifySourceFiles(sourceRoot, files, progress = () => {}) {
  for (const [index, source] of files.entries()) {
    const actual = await containedRegularFile(sourceRoot, source.relativePath);
    if (actual.sizeBytes !== source.sizeBytes || await fileSha256(actual.filename) !== source.sha256) {
      refuse("source bytes differ from inventory");
    }
    progress(index + 1, files.length);
  }
  return { sources: files.length, size_bytes: files.reduce((sum, file) => sum + file.sizeBytes, 0) };
}

async function realDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse("vault directory must not be a link");
  return realpath(directory);
}

/** The caller supplies the established metrology storage root, never an HTTP path. */
export async function prepareSourceVault({ sourceRoot, docsRoot, vaultRoot, files, sourceSetSha256, scan, progress = () => {} }) {
  if (!/^[a-f0-9]{64}$/.test(sourceSetSha256)) refuse("invalid source set digest");
  const trusted = await realDirectory(docsRoot);
  const requested = path.resolve(vaultRoot ?? path.join(trusted, "legacy-import"));
  if (!within(trusted, requested) || requested === trusted) refuse("vault must be below metrology storage");
  // Check/create one level at a time so a pre-existing intermediate symlink cannot escape.
  let parent = trusted;
  for (const part of path.relative(trusted, requested).split(path.sep)) {
    parent = await realDirectory(path.join(parent, part));
    if (!within(trusted, parent)) refuse("vault escapes metrology storage");
  }
  const target = await realDirectory(path.join(parent, sourceSetSha256));
  const results = [];
  const verdicts = new Map();
  for (const [index, source] of files.entries()) {
    const original = await containedRegularFile(sourceRoot, source.relativePath);
    const filename = source.sha256 + path.posix.extname(source.relativePath).toLowerCase();
    const destination = path.join(target, filename);
    if (original.sizeBytes !== source.sizeBytes || await fileSha256(original.filename) !== source.sha256) {
      refuse("source changed before copy");
    }
    try { await copyFile(original.filename, destination, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stored = await containedRegularFile(target, filename);
    if (stored.sizeBytes !== source.sizeBytes || await fileSha256(stored.filename) !== source.sha256) {
      refuse("vault copy integrity failure");
    }
    let verdict = verdicts.get(source.sha256);
    if (!verdict) {
      const scanned = await scan({ path: stored.filename });
      if (scanned.status !== "clean" || scanned.mode !== "enforce" || !scanned.provider ||
          ["none", "disabled", "configuration"].includes(scanned.provider)) refuse("enforced CLEAN antivirus scan required");
      verdict = { ...scanned, scanned_at: new Date().toISOString() };
      verdicts.set(source.sha256, verdict);
    }
    if (await fileSha256(stored.filename) !== source.sha256) refuse("vault changed during scan");
    // New imports use the canonical metrology namespace. Historical rows keep
    // their immutable uploads/docs/legacy-import references for the API
    // compatibility resolver.
    const reference = "uploads/docs/metrologie/" + path.relative(trusted, stored.filename).split(path.sep).join("/");
    results.push({ ...source, storagePath: reference, physicalPath: stored.filename, scan: verdict });
    progress(index + 1, files.length);
  }
  return results;
}
