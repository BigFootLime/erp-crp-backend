import { createHash, randomUUID } from "node:crypto";
import nodeFs, { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { Request, RequestHandler } from "express";
import multer from "multer";

import {
  getDocumentsRootPath,
  getExportsRootPath,
  getGeneratedRootPath,
  getInboundRootPath,
  getStorageRootPath,
  getTmpRootPath,
  getTmpStoragePath,
} from "../../utils/cerpStorage";
import { HttpError } from "../../utils/httpError";
import { getImagesRootPath } from "../../utils/imageStorage";
import logger from "../../utils/logger";
import {
  archiveMatchesExtension,
  isStructurallyValidatedArchiveExtension,
} from "./archive-validator";
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

type SecureUploadStorage = "memory" | "staging";

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
  | "commit-uncertain"
  | "committed"
  | "rolled-back"
  | "rollback-uncertain";
type UploadDestination = {
  destination: string;
  identity: UploadDestinationIdentity;
  state: UploadDestinationState;
  responseReleased: boolean;
};
export type UploadDestinationIdentity = Readonly<{
  dev: string;
  ino: string;
}>;
type UploadDestinationIdentityInput = Readonly<{
  dev: string | number | bigint;
  ino: string | number | bigint;
}>;
export type UploadFileReference = Readonly<{ path: string }>;
const uploadDestinations = new Map<string, Map<string, UploadDestination>>();
const secureStagingIdentities = new Map<string, UploadDestinationIdentity>();
const responseReleasedFiles = new WeakSet<object>();

declare const secureBufferDestinationBrand: unique symbol;
/** Opaque capability; its private path and inode identity are never serializable. */
export type SecureBufferDestinationOwnership = Readonly<{
  [secureBufferDestinationBrand]: true;
}>;
type SecureBufferDestinationRecord = Readonly<{
  destination: string;
  identity: UploadDestinationIdentity;
}>;
const secureBufferDestinations = new WeakMap<object, SecureBufferDestinationRecord>();

class UploadRequestAbortedError extends Error {
  constructor() {
    super("Upload request aborted");
    this.name = "UploadRequestAbortedError";
  }
}

type UploadHashChunkHook = (context: Readonly<{
  file: Express.Multer.File;
  signal: AbortSignal;
}>) => void | Promise<void>;

let uploadHashChunkHook: UploadHashChunkHook | null = null;

/** Deterministic cancellation injection for tests; never configured by application code. */
export function setUploadHashChunkHookForTests(hook: UploadHashChunkHook | null): void {
  uploadHashChunkHook = hook;
}

function throwIfUploadAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new UploadRequestAbortedError();
}

export class UploadDestinationCleanupError extends HttpError {
  readonly failedCount: number;

  constructor(failedCount: number) {
    super(
      503,
      "UPLOAD_CLEANUP_FAILED",
      "Le nettoyage sécurisé du fichier n’a pas pu être confirmé. Une intervention est requise."
    );
    this.name = "UploadDestinationCleanupError";
    this.failedCount = failedCount;
  }
}

function uploadPrivateDirectoryUnavailable(): HttpError {
  return new HttpError(
    503,
    "UPLOAD_STAGING_PERMISSION_FAILED",
    "La zone privée de dépôt n'a pas pu être validée."
  );
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative.length > 0
    && !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative)
  );
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const POSIX_PERMISSION_MASK = 0o7777;

function configuredUploadTrustRoots(): string[] {
  const roots = [
    getStorageRootPath(),
    getDocumentsRootPath(),
    getGeneratedRootPath(),
    getInboundRootPath(),
    getExportsRootPath(),
    getTmpRootPath(),
    getImagesRootPath(),
    process.env.CERP_GED_VAULT_ROOT?.trim(),
  ]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.resolve(root));
  return [...new Set(roots)];
}

function uploadTrustRootFor(candidate: string): string {
  const resolvedCandidate = path.resolve(candidate);
  const configured = configuredUploadTrustRoots()
    .filter((root) => pathIsInside(root, resolvedCandidate))
    .sort((left, right) => right.length - left.length)[0];
  if (configured) return configured;

  // Isolated tests and local callers may supply an application-owned parent
  // outside configured storage. Anchor at the nearest existing directory; the
  // ownership/ancestor checks below still reject a foreign or unsafe anchor.
  let existing = resolvedCandidate;
  while (!nodeFs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return existing;
}

function posixDirectoryFlags(): number {
  return nodeFs.constants.O_RDONLY
    | nodeFs.constants.O_DIRECTORY
    | nodeFs.constants.O_NOFOLLOW;
}

function currentPosixIdentity(): Readonly<{
  uid: bigint;
  gid: bigint;
  groups: ReadonlySet<bigint>;
}> {
  const uid = process.geteuid?.();
  const gid = process.getegid?.();
  if (uid === undefined || gid === undefined) throw uploadPrivateDirectoryUnavailable();
  const groups = new Set((process.getgroups?.() ?? []).map((group) => BigInt(group)));
  groups.add(BigInt(gid));
  return {
    uid: BigInt(uid),
    gid: BigInt(gid),
    groups,
  };
}

function configuredAdminTrustRoots(): ReadonlySet<string> {
  const configured = process.env.CERP_UPLOAD_ADMIN_TRUST_ROOTS?.trim();
  if (!configured || process.platform === "win32") return new Set<string>();
  const roots = new Set<string>();
  for (const entry of configured.split(path.delimiter).map((value) => value.trim()).filter(Boolean)) {
    const resolved = path.resolve(entry);
    const stat = nodeFs.lstatSync(resolved, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw uploadPrivateDirectoryUnavailable();
    }
    roots.add(nodeFs.realpathSync.native(resolved));
  }
  return roots;
}

function openVerifiedDirectory(directory: string): Readonly<{
  descriptor: number;
  stat: nodeFs.BigIntStats;
}> {
  const before = nodeFs.lstatSync(directory, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw uploadPrivateDirectoryUnavailable();
  }
  const descriptor = nodeFs.openSync(directory, posixDirectoryFlags());
  try {
    const opened = nodeFs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isDirectory()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw uploadPrivateDirectoryUnavailable();
    }
    return { descriptor, stat: opened };
  } catch (error) {
    nodeFs.closeSync(descriptor);
    throw error;
  }
}

function secureAncestorDirectory(
  directory: string,
  identity: ReturnType<typeof currentPosixIdentity>,
  adminTrustRoots: ReadonlySet<string>
): void {
  const opened = openVerifiedDirectory(directory);
  try {
    const mode = Number(opened.stat.mode) & POSIX_PERMISSION_MASK;
    const ownerIsService = opened.stat.uid === identity.uid;
    const groupCanWrite = (mode & 0o020) !== 0 && identity.groups.has(opened.stat.gid);
    const othersCanWrite = (mode & 0o002) !== 0;
    const sticky = (mode & 0o1000) !== 0;

    if (ownerIsService) {
      if (othersCanWrite || ((mode & 0o020) !== 0 && opened.stat.gid !== identity.gid)) {
        throw uploadPrivateDirectoryUnavailable();
      }
      if ((mode & 0o020) !== 0 && !sticky) {
        nodeFs.fchmodSync(opened.descriptor, mode | 0o1000);
      }
    } else {
      const administrativeOwner = opened.stat.uid === 0n || adminTrustRoots.has(directory);
      if (!administrativeOwner || ((othersCanWrite || groupCanWrite) && !sticky)) {
        throw uploadPrivateDirectoryUnavailable();
      }
    }

    const secured = nodeFs.fstatSync(opened.descriptor, { bigint: true });
    const securedMode = Number(secured.mode) & POSIX_PERMISSION_MASK;
    if (
      secured.dev !== opened.stat.dev
      || secured.ino !== opened.stat.ino
      || ((othersCanWrite || groupCanWrite || (ownerIsService && (mode & 0o020) !== 0))
        && (securedMode & 0o1000) === 0)
    ) {
      throw uploadPrivateDirectoryUnavailable();
    }
  } finally {
    nodeFs.closeSync(opened.descriptor);
  }
}

function canonicalAncestorPaths(directory: string): string[] {
  const parsed = path.parse(directory);
  const relative = path.relative(parsed.root, directory);
  const paths = [parsed.root];
  let current = parsed.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  return paths;
}

type DirectorySnapshot = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
  mode: number;
}>;

function inspectAncestorDirectory(
  directory: string,
  identity: ReturnType<typeof currentPosixIdentity>,
  adminTrustRoots: ReadonlySet<string>
): DirectorySnapshot {
  const opened = openVerifiedDirectory(directory);
  try {
    const mode = Number(opened.stat.mode) & POSIX_PERMISSION_MASK;
    const ownerIsService = opened.stat.uid === identity.uid;
    const groupCanWrite = (mode & 0o020) !== 0 && identity.groups.has(opened.stat.gid);
    const othersCanWrite = (mode & 0o002) !== 0;
    const sticky = (mode & 0o1000) !== 0;
    if (ownerIsService) {
      if (othersCanWrite || ((mode & 0o020) !== 0 && opened.stat.gid !== identity.gid)) {
        throw uploadPrivateDirectoryUnavailable();
      }
    } else {
      const administrativeOwner = opened.stat.uid === 0n || adminTrustRoots.has(directory);
      if (!administrativeOwner || ((othersCanWrite || groupCanWrite) && !sticky)) {
        throw uploadPrivateDirectoryUnavailable();
      }
    }
    return { path: directory, dev: opened.stat.dev, ino: opened.stat.ino, mode };
  } finally {
    nodeFs.closeSync(opened.descriptor);
  }
}

function inspectTrustedRootAncestors(resolvedRoot: string): Readonly<{
  realRoot: string;
  identity: ReturnType<typeof currentPosixIdentity>;
  adminTrustRoots: ReadonlySet<string>;
  ancestors: readonly DirectorySnapshot[];
}> {
  const rootBefore = nodeFs.lstatSync(resolvedRoot, { bigint: true });
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
    throw uploadPrivateDirectoryUnavailable();
  }
  const realRoot = nodeFs.realpathSync.native(resolvedRoot);
  const identity = currentPosixIdentity();
  const adminTrustRoots = configuredAdminTrustRoots();
  const ancestors = canonicalAncestorPaths(realRoot).map((ancestor) =>
    inspectAncestorDirectory(ancestor, identity, adminTrustRoots)
  );
  const rootAfter = nodeFs.lstatSync(resolvedRoot, { bigint: true });
  if (
    rootAfter.isSymbolicLink()
    || !rootAfter.isDirectory()
    || rootAfter.dev !== rootBefore.dev
    || rootAfter.ino !== rootBefore.ino
    || nodeFs.realpathSync.native(resolvedRoot) !== realRoot
    || rootAfter.uid !== identity.uid
    || rootAfter.gid !== identity.gid
  ) {
    throw uploadPrivateDirectoryUnavailable();
  }
  return { realRoot, identity, adminTrustRoots, ancestors };
}

function secureTrustedRootAncestors(resolvedRoot: string): Readonly<{
  realRoot: string;
  identity: ReturnType<typeof currentPosixIdentity> | null;
  adminTrustRoots: ReadonlySet<string>;
}> {
  const rootBefore = nodeFs.lstatSync(resolvedRoot, { bigint: true });
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
    throw uploadPrivateDirectoryUnavailable();
  }
  const realRoot = nodeFs.realpathSync.native(resolvedRoot);
  if (process.platform === "win32") {
    return { realRoot, identity: null, adminTrustRoots: new Set<string>() };
  }

  const identity = currentPosixIdentity();
  const adminTrustRoots = configuredAdminTrustRoots();
  // Walk top-down. Once a writable service-owned ancestor has gained sticky,
  // a same-group account can no longer rename the next service-owned entry.
  for (const ancestor of canonicalAncestorPaths(realRoot)) {
    secureAncestorDirectory(ancestor, identity, adminTrustRoots);
  }

  const rootAfter = nodeFs.lstatSync(resolvedRoot, { bigint: true });
  if (
    rootAfter.isSymbolicLink()
    || !rootAfter.isDirectory()
    || rootAfter.dev !== rootBefore.dev
    || rootAfter.ino !== rootBefore.ino
    || nodeFs.realpathSync.native(resolvedRoot) !== realRoot
    || rootAfter.uid !== identity.uid
    || rootAfter.gid !== identity.gid
  ) {
    throw uploadPrivateDirectoryUnavailable();
  }
  return { realRoot, identity, adminTrustRoots };
}

function ensureOwnedDirectoryMode(
  directory: string,
  realRoot: string,
  identity: ReturnType<typeof currentPosixIdentity> | null,
  mode: number
): void {
  const realDirectory = nodeFs.realpathSync.native(directory);
  if (!pathIsInside(realRoot, realDirectory)) throw uploadPrivateDirectoryUnavailable();

  if (process.platform === "win32") {
    const before = nodeFs.lstatSync(directory, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw uploadPrivateDirectoryUnavailable();
    }
    nodeFs.chmodSync(directory, mode);
    const after = nodeFs.lstatSync(directory, { bigint: true });
    if (
      after.isSymbolicLink()
      || !after.isDirectory()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || !pathIsInside(realRoot, nodeFs.realpathSync.native(directory))
    ) {
      throw uploadPrivateDirectoryUnavailable();
    }
    return;
  }

  if (!identity) throw uploadPrivateDirectoryUnavailable();
  const opened = openVerifiedDirectory(directory);
  try {
    if (opened.stat.uid !== identity.uid || opened.stat.gid !== identity.gid) {
      throw uploadPrivateDirectoryUnavailable();
    }
    nodeFs.fchmodSync(opened.descriptor, mode);
    const secured = nodeFs.fstatSync(opened.descriptor, { bigint: true });
    if (
      secured.dev !== opened.stat.dev
      || secured.ino !== opened.stat.ino
      || (Number(secured.mode) & POSIX_PERMISSION_MASK) !== mode
    ) {
      throw uploadPrivateDirectoryUnavailable();
    }
  } finally {
    nodeFs.closeSync(opened.descriptor);
  }
}

function existingPathComponents(root: string, directory: string): string[] {
  const relative = path.relative(root, directory);
  if (relative === "") return [];
  return relative.split(path.sep).filter(Boolean);
}

function validateOwnedPathFromRoot(
  resolvedRoot: string,
  resolvedDirectory: string,
  realRoot: string,
  identity: ReturnType<typeof currentPosixIdentity> | null,
  adminTrustRoots: ReadonlySet<string>,
  desiredMode: number | null,
  create: boolean
): void {
  let current = resolvedRoot;
  for (const segment of existingPathComponents(resolvedRoot, resolvedDirectory)) {
    current = path.join(current, segment);
    if (create) {
      try {
        nodeFs.mkdirSync(current, { mode: desiredMode ?? PRIVATE_DIRECTORY_MODE });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const before = nodeFs.lstatSync(current, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw uploadPrivateDirectoryUnavailable();
    }
    if (desiredMode === null && process.platform !== "win32") {
      if (!identity || before.uid !== identity.uid || before.gid !== identity.gid) {
        throw uploadPrivateDirectoryUnavailable();
      }
      secureAncestorDirectory(nodeFs.realpathSync.native(current), identity, adminTrustRoots);
      if (!pathIsInside(realRoot, nodeFs.realpathSync.native(current))) {
        throw uploadPrivateDirectoryUnavailable();
      }
    } else if (desiredMode !== null) {
      ensureOwnedDirectoryMode(current, realRoot, identity, desiredMode);
    } else if (!pathIsInside(realRoot, nodeFs.realpathSync.native(current))) {
      throw uploadPrivateDirectoryUnavailable();
    }
  }
}

function sharedChildMode(parent: string, identity: ReturnType<typeof currentPosixIdentity>): number {
  const opened = openVerifiedDirectory(parent);
  try {
    if (opened.stat.uid !== identity.uid || opened.stat.gid !== identity.gid) {
      throw uploadPrivateDirectoryUnavailable();
    }
    const mode = Number(opened.stat.mode) & POSIX_PERMISSION_MASK;
    if ((mode & 0o002) !== 0) throw uploadPrivateDirectoryUnavailable();
    // Preserve only the parent's deliberate group access and setgid class.
    // Never add group-write merely because this is a shared application path.
    return 0o700 | (mode & 0o070) | (mode & 0o2000) | ((mode & 0o020) !== 0 ? 0o1000 : 0);
  } finally {
    nodeFs.closeSync(opened.descriptor);
  }
}

function ensureSharedPathFromRoot(
  resolvedRoot: string,
  resolvedDirectory: string,
  realRoot: string,
  identity: ReturnType<typeof currentPosixIdentity> | null,
  adminTrustRoots: ReadonlySet<string>
): void {
  let current = resolvedRoot;
  for (const segment of existingPathComponents(resolvedRoot, resolvedDirectory)) {
    const next = path.join(current, segment);
    let created = false;
    let createdMode = PRIVATE_DIRECTORY_MODE;
    if (process.platform !== "win32") {
      if (!identity) throw uploadPrivateDirectoryUnavailable();
      createdMode = sharedChildMode(current, identity);
    }
    try {
      nodeFs.mkdirSync(next, { mode: createdMode });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const before = nodeFs.lstatSync(next, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw uploadPrivateDirectoryUnavailable();
    }
    if (!pathIsInside(realRoot, nodeFs.realpathSync.native(next))) {
      throw uploadPrivateDirectoryUnavailable();
    }
    if (process.platform === "win32") {
      if (created) ensureOwnedDirectoryMode(next, realRoot, identity, createdMode);
    } else {
      if (!identity || before.uid !== identity.uid || before.gid !== identity.gid) {
        throw uploadPrivateDirectoryUnavailable();
      }
      if (created) ensureOwnedDirectoryMode(next, realRoot, identity, createdMode);
      secureAncestorDirectory(nodeFs.realpathSync.native(next), identity, adminTrustRoots);
    }
    current = next;
  }
}

/**
 * Create and validate an application-private directory without ever following
 * a pre-existing symlink/junction. Shared service-owned ancestors are migrated
 * from 2770 to 3770 in place; sticky protects their service-owned entries from
 * same-group rename/delete while preserving the deployed group-write model.
 */
export function ensurePrivateUploadDirectory(
  directory: string,
  expectedRoot: string,
  trustedRoot = uploadTrustRootFor(expectedRoot)
): string {
  const resolvedTrustedRoot = path.resolve(trustedRoot);
  const resolvedRoot = path.resolve(expectedRoot);
  const resolvedDirectory = path.resolve(directory);
  if (
    !pathIsInside(resolvedTrustedRoot, resolvedRoot)
    || resolvedDirectory === resolvedRoot
    || !pathIsInside(resolvedRoot, resolvedDirectory)
  ) {
    throw uploadPrivateDirectoryUnavailable();
  }

  try {
    const securedRoot = secureTrustedRootAncestors(resolvedTrustedRoot);
    validateOwnedPathFromRoot(
      resolvedTrustedRoot,
      resolvedRoot,
      securedRoot.realRoot,
      securedRoot.identity,
      securedRoot.adminTrustRoots,
      null,
      false
    );
    validateOwnedPathFromRoot(
      resolvedRoot,
      resolvedDirectory,
      securedRoot.realRoot,
      securedRoot.identity,
      securedRoot.adminTrustRoots,
      PRIVATE_DIRECTORY_MODE,
      true
    );
    return resolvedDirectory;
  } catch (error) {
    if (error instanceof HttpError && error.code === "UPLOAD_STAGING_PERMISSION_FAILED") {
      throw error;
    }
    throw uploadPrivateDirectoryUnavailable();
  }
}

/**
 * Create a durable/shared path one component at a time. Existing access bits
 * are never broadened: 2770 gains sticky (3770), while 2750/0750 stays
 * non-group-writable. A new child inherits that deliberate access class.
 */
export function ensureSharedUploadDirectory(
  directory: string,
  trustedRoot = uploadTrustRootFor(directory)
): string {
  const resolvedTrustedRoot = path.resolve(trustedRoot);
  const resolvedDirectory = path.resolve(directory);
  if (!pathIsInside(resolvedTrustedRoot, resolvedDirectory)) {
    throw uploadPrivateDirectoryUnavailable();
  }
  try {
    const securedRoot = secureTrustedRootAncestors(resolvedTrustedRoot);
    ensureSharedPathFromRoot(
      resolvedTrustedRoot,
      resolvedDirectory,
      securedRoot.realRoot,
      securedRoot.identity,
      securedRoot.adminTrustRoots
    );
    return resolvedDirectory;
  } catch (error) {
    if (error instanceof HttpError && error.code === "UPLOAD_STAGING_PERMISSION_FAILED") {
      throw error;
    }
    throw uploadPrivateDirectoryUnavailable();
  }
}

function privateUploadTreeRootFor(candidate: string): string | null {
  const resolved = path.resolve(candidate);
  const namedPrivateSegment = resolved.split(path.sep).findIndex((segment) =>
    segment === ".secure-delete" || segment === ".secure-buffer-staging"
  );
  if (namedPrivateSegment >= 0) return resolved;

  const quarantine = path.resolve(getTmpRootPath(), "upload-quarantine");
  if (pathIsInside(quarantine, resolved)) return quarantine;
  const ged = process.env.CERP_GED_VAULT_ROOT?.trim();
  if (ged) {
    for (const subdirectory of ["vault", "staging"] as const) {
      const privateRoot = path.resolve(ged, subdirectory);
      if (pathIsInside(privateRoot, resolved)) return privateRoot;
    }
  }
  return null;
}

function uploadPreflightNodeLimit(): number {
  const raw = Number(process.env.CERP_UPLOAD_PREFLIGHT_MAX_NODES ?? 200_000);
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 1_000_000) {
    throw uploadPrivateDirectoryUnavailable();
  }
  return raw;
}

type PreflightFileRecord = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
}>;

type PreflightDirectoryRecord = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
  mode: number;
}>;

type UploadTreeInventory = Readonly<{
  root: string;
  realRoot: string;
  identity: ReturnType<typeof currentPosixIdentity>;
  adminTrustRoots: ReadonlySet<string>;
  ancestors: readonly DirectorySnapshot[];
  directories: readonly PreflightDirectoryRecord[];
  files: readonly PreflightFileRecord[];
  visited: number;
}>;

function hardenExistingUploadFile(
  record: PreflightFileRecord,
  identity: ReturnType<typeof currentPosixIdentity>
): void {
  const before = nodeFs.lstatSync(record.path, { bigint: true });
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.dev !== record.dev
    || before.ino !== record.ino
  ) {
    throw uploadPrivateDirectoryUnavailable();
  }
  const descriptor = nodeFs.openSync(
    record.path,
    nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW
  );
  try {
    const opened = nodeFs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile()
      || opened.dev !== record.dev
      || opened.ino !== record.ino
      || opened.uid !== identity.uid
      || opened.gid !== identity.gid
      || opened.size !== record.size
      || opened.mtimeNs !== record.mtimeNs
    ) {
      throw uploadPrivateDirectoryUnavailable();
    }
    nodeFs.fchmodSync(descriptor, 0o600);
    const secured = nodeFs.fstatSync(descriptor, { bigint: true });
    if (
      secured.dev !== record.dev
      || secured.ino !== record.ino
      || secured.size !== record.size
      || secured.mtimeNs !== record.mtimeNs
      || (Number(secured.mode) & POSIX_PERMISSION_MASK) !== 0o600
    ) {
      throw uploadPrivateDirectoryUnavailable();
    }
  } finally {
    nodeFs.closeSync(descriptor);
  }
}

function inventoryExistingUploadTree(root: string): UploadTreeInventory {
  const resolvedRoot = path.resolve(root);
  const inspected = inspectTrustedRootAncestors(resolvedRoot);
  const limit = uploadPreflightNodeLimit();
  const pending = [resolvedRoot];
  const directories: PreflightDirectoryRecord[] = [];
  const files: PreflightFileRecord[] = [];
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > limit) throw uploadPrivateDirectoryUnavailable();
    const before = nodeFs.lstatSync(current, { bigint: true });
    if (
      before.isSymbolicLink()
      || !before.isDirectory()
      || before.uid !== inspected.identity.uid
      || before.gid !== inspected.identity.gid
      || (Number(before.mode) & 0o002) !== 0
    ) {
      throw uploadPrivateDirectoryUnavailable();
    }
    const realCurrent = nodeFs.realpathSync.native(current);
    if (!pathIsInside(inspected.realRoot, realCurrent)) {
      throw uploadPrivateDirectoryUnavailable();
    }
    directories.push({
      path: current,
      dev: before.dev,
      ino: before.ino,
      mode: Number(before.mode) & POSIX_PERMISSION_MASK,
    });

    for (const entry of nodeFs.readdirSync(current)) {
      const child = path.join(current, entry);
      const childStat = nodeFs.lstatSync(child, { bigint: true });
      if (
        childStat.isSymbolicLink()
        || (!childStat.isDirectory() && !childStat.isFile())
        || childStat.uid !== inspected.identity.uid
        || childStat.gid !== inspected.identity.gid
        || (childStat.isDirectory() && (Number(childStat.mode) & 0o002) !== 0)
      ) {
        throw uploadPrivateDirectoryUnavailable();
      }
      if (childStat.isDirectory()) pending.push(child);
      else {
        visited += 1;
        if (visited > limit) throw uploadPrivateDirectoryUnavailable();
        const record: PreflightFileRecord = {
          path: child,
          dev: childStat.dev,
          ino: childStat.ino,
          nlink: childStat.nlink,
          size: childStat.size,
          mtimeNs: childStat.mtimeNs,
        };
        files.push(record);
      }
    }
  }
  return {
    root: resolvedRoot,
    realRoot: inspected.realRoot,
    identity: inspected.identity,
    adminTrustRoots: inspected.adminTrustRoots,
    ancestors: inspected.ancestors,
    directories,
    files,
    visited,
  };
}

function assertDirectorySnapshotUnchanged(snapshot: DirectorySnapshot): void {
  const current = nodeFs.lstatSync(snapshot.path, { bigint: true });
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || current.dev !== snapshot.dev
    || current.ino !== snapshot.ino
    || (Number(current.mode) & POSIX_PERMISSION_MASK) !== snapshot.mode
  ) {
    throw uploadPrivateDirectoryUnavailable();
  }
}

function migrateInventoriedUploadTrees(
  inventories: readonly UploadTreeInventory[],
  boundaryInspections: readonly ReturnType<typeof inspectTrustedRootAncestors>[]
): number {
  const observedLinks = new Map<string, bigint>();
  for (const inventory of inventories) {
    for (const file of inventory.files) {
      const key = `${file.dev}:${file.ino}`;
      observedLinks.set(key, (observedLinks.get(key) ?? 0n) + 1n);
    }
  }
  for (const inventory of inventories) {
    for (const file of inventory.files) {
      if (observedLinks.get(`${file.dev}:${file.ino}`) !== file.nlink) {
        throw uploadPrivateDirectoryUnavailable();
      }
    }
  }

  // Discovery and every global validation above are mutation-free. Only now
  // stabilize all configured/admin ancestor chains, once, from top to bottom.
  const ancestorSnapshots = new Map<string, DirectorySnapshot>();
  for (const inspection of boundaryInspections) {
    for (const snapshot of inspection.ancestors) {
      const existing = ancestorSnapshots.get(snapshot.path);
      if (existing && (
        existing.dev !== snapshot.dev
        || existing.ino !== snapshot.ino
        || existing.mode !== snapshot.mode
      )) {
        throw uploadPrivateDirectoryUnavailable();
      }
      ancestorSnapshots.set(snapshot.path, snapshot);
    }
  }
  const identity = inventories[0]?.identity ?? boundaryInspections[0]?.identity;
  const adminTrustRoots = boundaryInspections[0]?.adminTrustRoots ?? new Set<string>();
  if (!identity) throw uploadPrivateDirectoryUnavailable();
  for (const snapshot of [...ancestorSnapshots.values()].sort((left, right) =>
    left.path.length - right.path.length
  )) {
    assertDirectorySnapshotUnchanged(snapshot);
    secureAncestorDirectory(snapshot.path, identity, adminTrustRoots);
  }

  for (const inventory of inventories) {
    for (const directory of inventory.directories) {
      const current = nodeFs.lstatSync(directory.path, { bigint: true });
      const currentMode = Number(current.mode) & POSIX_PERMISSION_MASK;
      const expectedAfterAncestorStabilization = (directory.mode & 0o020) !== 0
        ? directory.mode | 0o1000
        : directory.mode;
      if (
        !current.isDirectory()
        || current.isSymbolicLink()
        || current.dev !== directory.dev
        || current.ino !== directory.ino
        || (currentMode !== directory.mode && currentMode !== expectedAfterAncestorStabilization)
      ) {
        throw uploadPrivateDirectoryUnavailable();
      }
      const realCurrent = nodeFs.realpathSync.native(directory.path);
      if (!pathIsInside(inventory.realRoot, realCurrent)) {
        throw uploadPrivateDirectoryUnavailable();
      }
      if (privateUploadTreeRootFor(directory.path)) {
        ensureOwnedDirectoryMode(
          directory.path,
          inventory.realRoot,
          inventory.identity,
          PRIVATE_DIRECTORY_MODE
        );
      } else {
        // Access-preserving migration only: 2770 -> 3770. 2750 and 0750 stay
        // non-group-writable, and no read/write bit is ever added.
        secureAncestorDirectory(realCurrent, inventory.identity, inventory.adminTrustRoots);
      }
    }
  }

  const hardened = new Set<string>();
  for (const inventory of inventories) {
    for (const file of inventory.files) {
      const key = `${file.dev}:${file.ino}`;
      if (hardened.has(key)) continue;
      hardenExistingUploadFile(file, inventory.identity);
      hardened.add(key);
    }
  }
  return inventories.reduce((sum, inventory) => sum + inventory.visited, 0);
}

/** Startup migration/validation for configured storage roots, before routes load. */
export function preflightSecureUploadStorageRoots(): readonly string[] {
  const storageRoot = path.resolve(getStorageRootPath());
  const configuredRoots = configuredUploadTrustRoots();
  for (const root of configuredRoots) {
    if (!nodeFs.existsSync(root)) throw uploadPrivateDirectoryUnavailable();
    const stat = nodeFs.lstatSync(root, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw uploadPrivateDirectoryUnavailable();
  }
  // CERP_STORAGE_ROOT is a boundary, not an application subtree: on HYPERBOX
  // it also contains the live postgres:postgres cluster. Secure the root entry
  // itself above, then recurse only through exact application allowlist roots.
  const hardenedApplicationRoots = [
    getDocumentsRootPath(),
    getGeneratedRootPath(),
    getExportsRootPath(),
    getTmpRootPath(),
    getImagesRootPath(),
    process.env.CERP_GED_VAULT_ROOT?.trim(),
  ]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.resolve(root));
  const inboundRoot = path.resolve(getInboundRootPath());
  if (
    hardenedApplicationRoots.some((root) => root === storageRoot)
    || inboundRoot === storageRoot
    || hardenedApplicationRoots.some((root) =>
      pathIsInside(root, inboundRoot) || pathIsInside(inboundRoot, root)
    )
  ) {
    throw uploadPrivateDirectoryUnavailable();
  }
  const traversalRoots = [...new Set(hardenedApplicationRoots)].filter((candidate) =>
    !hardenedApplicationRoots.some((other) => other !== candidate && pathIsInside(other, candidate))
  );
  let visited = 0;
  if (process.platform !== "win32") {
    // Snapshot every boundary and every application subtree without mutation.
    // No chmod occurs until all types, owners, node bounds and global hardlink
    // cardinalities have been validated across the full allowlist.
    const boundaryInspections = configuredRoots.map(inspectTrustedRootAncestors);
    const inventories = traversalRoots.map(inventoryExistingUploadTree);
    const totalNodes = inventories.reduce((sum, inventory) => sum + inventory.visited, 0);
    if (totalNodes > uploadPreflightNodeLimit()) throw uploadPrivateDirectoryUnavailable();
    visited = migrateInventoriedUploadTrees(inventories, boundaryInspections);
  }
  logger.info("[UPLOAD_STORAGE] preflight migration complete", JSON.stringify({
    root_count: traversalRoots.length,
    excluded_inbound_roots: 1,
    visited_nodes: visited,
  }));
  return configuredRoots;
}

/**
 * Registers an application-managed destination created from an uploaded file.
 * Registration transfers ownership out of central staging. A response close
 * can happen after COMMIT (or after COMMIT was applied but its ACK was lost),
 * so the response lifecycle never deletes a registered destination.
 */
function normalizeUploadDestinationIdentity(
  identity: UploadDestinationIdentityInput
): UploadDestinationIdentity {
  return { dev: String(identity.dev), ino: String(identity.ino) };
}

function sameUploadDestinationIdentity(
  expected: UploadDestinationIdentity,
  actual: UploadDestinationIdentityInput
): boolean {
  return expected.dev === String(actual.dev) && expected.ino === String(actual.ino);
}

type OwnedPathRemovalHook = (context: Readonly<{
  destination: string;
  tombstone: string;
}>) => void | Promise<void>;
let ownedPathRemovalHook: OwnedPathRemovalHook | null = null;

/** Deterministic race injection for tests; never configured by application code. */
export function setOwnedPathRemovalHookForTests(hook: OwnedPathRemovalHook | null): void {
  ownedPathRemovalHook = hook;
}

/**
 * Remove a pathname without an lstat→unlink race. rename() first detaches the
 * current directory entry atomically into a random name inside a private
 * same-filesystem tombstone directory. Only the expected inode is then
 * unlinked. A moved third-party inode is restored with exclusive link() or is
 * retained at the tombstone with an observable error; it is never deleted.
 */
export async function removeOwnedPathSafely(
  destination: string,
  expectedIdentity: UploadDestinationIdentityInput
): Promise<"deleted" | "absent"> {
  const resolvedDestination = path.resolve(destination);
  const expected = normalizeUploadDestinationIdentity(expectedIdentity);
  const tombstoneDirectory = path.join(path.dirname(resolvedDestination), ".secure-delete");
  const tombstone = path.join(tombstoneDirectory, `${randomUUID()}.tombstone`);
  try {
    ensurePrivateUploadDirectory(tombstoneDirectory, path.dirname(resolvedDestination));
    await ownedPathRemovalHook?.({ destination: resolvedDestination, tombstone });
    await fs.rename(resolvedDestination, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new UploadDestinationCleanupError(1);
  }

  let moved;
  try {
    moved = await fs.lstat(tombstone, { bigint: true });
  } catch {
    throw new UploadDestinationCleanupError(1);
  }

  if (moved.isFile() && sameUploadDestinationIdentity(expected, moved)) {
    try {
      await fs.unlink(tombstone);
      return "deleted";
    } catch {
      throw new UploadDestinationCleanupError(1);
    }
  }

  let restored = false;
  try {
    // link() is exclusive and cannot overwrite a new writer C. Keep the private
    // tombstone even after restoring B: deleting that last protected link would
    // reintroduce a race if another writer replaced the restored pathname.
    await fs.link(tombstone, resolvedDestination);
    restored = true;
  } catch {
    logger.error("[UPLOAD_CLEANUP] ownership mismatch preserved", JSON.stringify({
      state: "identity-mismatch",
      restored,
    }));
    throw new UploadDestinationCleanupError(1);
  }
  logger.error("[UPLOAD_CLEANUP] ownership mismatch preserved", JSON.stringify({
    state: "identity-mismatch",
    restored,
  }));
  // A mismatched inode is never a successful cleanup, even when its original
  // pathname could be restored without overwriting a concurrent writer.
  throw new UploadDestinationCleanupError(1);
}

async function copyBetweenOpenFiles(
  source: Awaited<ReturnType<typeof fs.open>>,
  destination: Awaited<ReturnType<typeof fs.open>>
): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(
        buffer,
        written,
        bytesRead - written,
        position + written
      );
      if (result.bytesWritten <= 0) {
        throw Object.assign(new Error("Exclusive upload copy made no progress"), { code: "EIO" });
      }
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
}

async function hashOpenFile(
  handle: Awaited<ReturnType<typeof fs.open>>
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { sha256: hash.digest("hex"), size: position };
}

function secureBufferRecord(
  ownership: SecureBufferDestinationOwnership
): SecureBufferDestinationRecord {
  const record = secureBufferDestinations.get(ownership);
  if (!record) throw new Error("Unknown secure buffer destination ownership");
  return record;
}

/**
 * Publish an in-memory upload without ever exposing a partial final pathname.
 * A private 0600 staging inode is fsynced and then linked to the exclusive
 * application-generated destination. Ownership metadata lives only in a
 * WeakMap-backed opaque capability and therefore cannot leak through JSON.
 */
export async function writeSecureBufferToDestination(
  buffer: Buffer,
  destination: string
): Promise<SecureBufferDestinationOwnership> {
  const snapshot = Buffer.from(buffer);
  const resolvedDestination = path.resolve(destination);
  const stagingDirectory = path.join(path.dirname(resolvedDestination), ".secure-buffer-staging");
  const stagingPath = path.join(stagingDirectory, `${randomUUID()}.part`);
  ensurePrivateUploadDirectory(stagingDirectory, path.dirname(resolvedDestination));

  let stagingHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let ownership: SecureBufferDestinationOwnership | null = null;
  let primaryError: unknown = null;
  try {
    stagingHandle = await fs.open(stagingPath, "wx", 0o600);
    await stagingHandle.writeFile(snapshot);
    await stagingHandle.sync();
    const stagingStat = await stagingHandle.stat({ bigint: true });
    await stagingHandle.close();
    stagingHandle = null;

    await fs.link(stagingPath, resolvedDestination);
    ownership = Object.freeze(Object.create(null)) as SecureBufferDestinationOwnership;
    secureBufferDestinations.set(ownership, {
      destination: resolvedDestination,
      identity: normalizeUploadDestinationIdentity(stagingStat),
    });
    const current = await fs.lstat(resolvedDestination, { bigint: true });
    if (
      !current.isFile()
      || !sameUploadDestinationIdentity(normalizeUploadDestinationIdentity(stagingStat), current)
    ) {
      throw new HttpError(
        409,
        "UPLOAD_FILE_CHANGED",
        "Le fichier durable a été remplacé pendant sa publication."
      );
    }
  } catch (error) {
    primaryError = error;
  } finally {
    await stagingHandle?.close().catch(() => undefined);
  }

  let stagingCleanupFailed = false;
  try {
    await fs.unlink(stagingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") stagingCleanupFailed = true;
  }

  if (primaryError || stagingCleanupFailed) {
    if (ownership) await cleanupSecureBufferDestination(ownership);
    if (stagingCleanupFailed) throw new UploadDestinationCleanupError(1);
    throw primaryError;
  }
  if (!ownership) throw new Error("Secure buffer writer returned no ownership");
  return ownership;
}

/** Delete only the inode represented by the opaque capability. */
export async function cleanupSecureBufferDestination(
  ownership: SecureBufferDestinationOwnership
): Promise<"deleted" | "absent"> {
  const record = secureBufferRecord(ownership);
  try {
    const outcome = await removeOwnedPathSafely(record.destination, record.identity);
    secureBufferDestinations.delete(ownership);
    return outcome;
  } catch (error) {
    if (error instanceof UploadDestinationCleanupError) throw error;
    throw new UploadDestinationCleanupError(1);
  }
}

/** Fresh physical identity, size, and SHA verification for COMMIT reconciliation. */
export async function verifySecureBufferDestination(
  ownership: SecureBufferDestinationOwnership,
  expectedSha256: string,
  expectedSize: number
): Promise<boolean> {
  const record = secureBufferRecord(ownership);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(record.destination, "r");
    const acquired = await handle.stat({ bigint: true });
    if (!acquired.isFile() || !sameUploadDestinationIdentity(record.identity, acquired)) return false;
    const actual = await hashOpenFile(handle);
    if (actual.sha256 !== expectedSha256 || actual.size !== expectedSize) return false;
    const current = await fs.lstat(record.destination, { bigint: true });
    return current.isFile() && sameUploadDestinationIdentity(record.identity, current);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function registerUploadDestination(
  file: Readonly<{ path: string }>,
  destination: string,
  acquiredIdentity?: UploadDestinationIdentityInput
): void {
  const source = path.resolve(file.path);
  const resolved = path.resolve(destination);
  // Actual transfer paths pass the fstat identity from the exclusively
  // acquired handle. The synchronous fallback keeps legacy/manual callers
  // identity-safe while they migrate to handle-based acquisition.
  const identity = normalizeUploadDestinationIdentity(
    acquiredIdentity ?? nodeFs.statSync(resolved, { bigint: true })
  );
  const destinations = uploadDestinations.get(source) ?? new Map<string, UploadDestination>();
  destinations.set(resolved, {
    destination: resolved,
    identity,
    state: "transferred",
    responseReleased: responseReleasedFiles.has(file),
  });
  uploadDestinations.set(source, destinations);
}

function releaseTerminalDestinationState(
  source: string,
  destinations: Map<string, UploadDestination>
): void {
  const terminal = new Set<UploadDestinationState>([
    "committed",
    "rolled-back",
    "commit-uncertain",
    "rollback-uncertain",
  ]);
  if (Array.from(destinations.values()).every((record) => record.responseReleased && terminal.has(record.state))) {
    uploadDestinations.delete(source);
  }
}

function updateUploadDestinationState(
  files: readonly UploadFileReference[],
  state: UploadDestinationState
): void {
  for (const file of files) {
    const source = path.resolve(file.path);
    const destinations = uploadDestinations.get(source);
    if (!destinations) continue;
    for (const record of destinations.values()) record.state = state;
    releaseTerminalDestinationState(source, destinations);
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

/** Preserve the durable destination but release lifecycle bookkeeping. */
export function markUploadCommitUncertain(files: readonly UploadFileReference[]): void {
  updateUploadDestinationState(files, "commit-uncertain");
}

/** Mark ownership as indeterminate when a pre-COMMIT rollback could not be confirmed. */
export function markUploadRollbackUncertain(files: readonly UploadFileReference[]): void {
  updateUploadDestinationState(files, "rollback-uncertain");
}

export function getRegisteredUploadDestinationCountForTests(): number {
  let count = 0;
  for (const destinations of uploadDestinations.values()) count += destinations.size;
  return count;
}

export function clearRegisteredUploadDestinationsForTests(): void {
  uploadDestinations.clear();
}

/**
 * Delete transferred destinations only after the caller has proven that the
 * database transaction rolled back before COMMIT was attempted.
 */
async function cleanupOwnedDestinations(
  files: readonly UploadFileReference[],
  allowedStates: ReadonlySet<UploadDestinationState>
): Promise<void> {
  let failedCount = 0;
  for (const file of files) {
    const source = path.resolve(file.path);
    const destinations = uploadDestinations.get(source);
    if (!destinations) continue;
    for (const record of destinations.values()) {
      if (record.state === "rolled-back") continue;
      if (!allowedStates.has(record.state)) {
        logger.error("[UPLOAD_OWNERSHIP] refused unsafe cleanup", JSON.stringify({ state: record.state }));
        continue;
      }
      try {
        await removeOwnedPathSafely(record.destination, record.identity);
        record.state = "rolled-back";
      } catch (error) {
        failedCount += 1;
        logger.error("[UPLOAD_OWNERSHIP] durable cleanup failed", JSON.stringify({
          state: record.state,
          error: (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : "unknown"),
        }));
        // Keep both the non-terminal state and registry entry: operators (or a
        // later idempotent retry) still need an observable ownership record.
      }
    }
    releaseTerminalDestinationState(source, destinations);
  }
  if (failedCount > 0) throw new UploadDestinationCleanupError(failedCount);
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
    responseReleasedFiles.add(file);
    const source = path.resolve(file.path);
    const registered = uploadDestinations.get(source);
    if (!registered) return [];
    const destinations = Array.from(registered.values());
    for (const record of destinations) record.responseReleased = true;
    releaseTerminalDestinationState(source, registered);
    return destinations;
  });
}

function auditUpload(
  req: Request,
  usage: UploadUsage,
  outcome: "accepted" | "rejected" | "cleaned" | "cleanup_failed",
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

async function sampleFile(file: Express.Multer.File, signal: AbortSignal): Promise<FileSample> {
  throwIfUploadAborted(signal);
  if (file.buffer) {
    return {
      head: file.buffer.subarray(0, SAMPLE_BYTES),
      tail: file.buffer.subarray(Math.max(0, file.buffer.length - SAMPLE_BYTES)),
    };
  }
  const handle = await fs.open(file.path, "r");
  try {
    throwIfUploadAborted(signal);
    const head = Buffer.alloc(Math.min(SAMPLE_BYTES, file.size));
    const tail = Buffer.alloc(Math.min(SAMPLE_BYTES, file.size));
    if (head.length) await handle.read(head, 0, head.length, 0);
    throwIfUploadAborted(signal);
    if (tail.length) await handle.read(tail, 0, tail.length, Math.max(0, file.size - tail.length));
    throwIfUploadAborted(signal);
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
    case ".xlsx":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".zip":
    case ".3mf":
      // Sampling cannot establish ZIP structure. The upload path validates the
      // complete central/local directory, entries, CRCs and package manifests.
      return false;
    case ".7z":
      return startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    case ".stp":
    case ".step":
      return isProbablyText(head) && containsAscii(sample, "ISO-10303-21");
    case ".stl": { // Binary STL: 80-byte header, uint32 LE count, then exact 50-byte records.
      const asciiHead = head.toString("ascii").toLowerCase();
      const asciiTail = tail.toString("ascii").toLowerCase();
      if (isProbablyText(head) && asciiHead.trimStart().startsWith("solid")) {
        return asciiHead.includes("facet normal") && asciiTail.includes("endsolid");
      }
      if (size < 84 || head.length < 84) return false;
      const triangleCount = head.readUInt32LE(80);
      return 84 + (50 * triangleCount) === size;
    }
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

async function sha256(file: Express.Multer.File, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  if (file.buffer) {
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < file.buffer.length; offset += chunkSize) {
      throwIfUploadAborted(signal);
      hash.update(file.buffer.subarray(offset, Math.min(file.buffer.length, offset + chunkSize)));
      await uploadHashChunkHook?.({ file, signal });
      // Yield between bounded chunks so req/res cancellation is observable for
      // memory-backed uploads instead of monopolising the event loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throwIfUploadAborted(signal);
    return hash.digest("hex");
  }
  const stream = createReadStream(file.path, { signal });
  try {
    for await (const chunk of stream) {
      throwIfUploadAborted(signal);
      hash.update(chunk);
      await uploadHashChunkHook?.({ file, signal });
    }
    throwIfUploadAborted(signal);
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

type StagingCleanupResult = Readonly<{
  attemptedCount: number;
  failedCount: number;
}>;

async function cleanupStagingPaths(paths: Iterable<string>): Promise<StagingCleanupResult> {
  const uniquePaths = Array.from(new Set(paths));
  let failedCount = 0;
  await Promise.all(uniquePaths.map(async (filePath) => {
    const resolved = path.resolve(filePath);
    const identity = secureStagingIdentities.get(resolved);
    if (!identity) {
      try {
        await fs.lstat(resolved);
        failedCount += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failedCount += 1;
      }
      return;
    }
    try {
      await removeOwnedPathSafely(resolved, identity);
      secureStagingIdentities.delete(resolved);
    } catch {
      // Never retry an identity mismatch: its pathname may now be absent while
      // the preserved third-party inode remains in .secure-delete.
      failedCount += 1;
    }
  }));
  return { attemptedCount: uniquePaths.length, failedCount };
}

/**
 * Synchronously confirm cleanup of inbound Multer staging before returning a
 * validation/repository error. Success preserves the original HTTP error;
 * failure is promoted to an observable 503 cleanup incident.
 */
export async function cleanupIncomingUploadStaging(
  files: readonly UploadFileReference[]
): Promise<void> {
  const cleanup = await cleanupStagingPaths(files.map((file) => file.path));
  if (cleanup.failedCount > 0) throw new UploadDestinationCleanupError(cleanup.failedCount);
}

/** Test fixture registration; production staging is registered at exclusive open. */
export async function registerIncomingUploadStagingForTests(
  files: readonly UploadFileReference[]
): Promise<void> {
  if (process.env.NODE_ENV !== "test") throw new Error("Test-only upload staging registration");
  for (const file of files) {
    const resolved = path.resolve(file.path);
    const stat = await fs.lstat(resolved, { bigint: true });
    if (!stat.isFile()) throw new Error("Test staging fixture is not a file");
    secureStagingIdentities.set(resolved, normalizeUploadDestinationIdentity(stat));
  }
}

function multerFiles(req: Request): Express.Multer.File[] {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === "object") return Object.values(req.files).flat();
  return [];
}

/**
 * Transfers one validated staging file to an application-generated durable
 * destination without ever replacing an existing target. A hard link provides
 * an atomic, exclusive O(1) transfer on one filesystem; EXDEV alone falls back
 * to an exclusive `open("wx", 0600)` followed by a streamed copy through that
 * acquired handle. Ownership is registered with the acquired dev/ino identity
 * before any copy byte or source unlink, so a partial write remains
 * compensable without granting authority over a later replacement path.
 *
 * Callers must invoke this helper from an upload transaction and must keep the
 * Multer file's `path` pointing at the staging ownership key.
 */
export async function transferSecureUploadToDestination(
  file: UploadFileReference,
  destination: string
): Promise<string> {
  const source = path.resolve(file.path);
  const resolvedDestination = path.resolve(destination);
  let sourceHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let destinationIdentity: UploadDestinationIdentity | null = null;
  let ownsDestination = false;

  try {
    sourceHandle = await fs.open(source, "r");
    const sourceStat = await sourceHandle.stat({ bigint: true });
    if (!sourceStat.isFile()) {
      throw new HttpError(409, "UPLOAD_FILE_CHANGED", "Le fichier déposé a changé pendant son transfert.");
    }

    try {
      // Unlike POSIX rename(), link() fails with EEXIST instead of silently
      // replacing the destination. The source handle's fstat identity is the
      // identity link() must publish; register it synchronously as soon as the
      // syscall succeeds, before any fallible open/chmod operation.
      await fs.link(source, resolvedDestination);
      destinationIdentity = normalizeUploadDestinationIdentity(sourceStat);
      registerUploadDestination(file, resolvedDestination, sourceStat);
      ownsDestination = true;

      destinationHandle = await fs.open(resolvedDestination, "r");
      const acquired = await destinationHandle.stat({ bigint: true });
      if (!sameUploadDestinationIdentity(destinationIdentity, acquired)) {
        throw new HttpError(
          409,
          "UPLOAD_FILE_CHANGED",
          "Le fichier durable a été remplacé pendant son transfert."
        );
      }
      await destinationHandle.chmod(0o600);
      await destinationHandle.close();
      destinationHandle = null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (ownsDestination || code !== "EXDEV") throw error;

      try {
        destinationHandle = await fs.open(resolvedDestination, "wx", 0o600);
      } catch (openError) {
        // Failure before exclusive acquisition creates no ownership record. A
        // later writer of the same application-generated name is not ours.
        throw openError;
      }

      const acquired = await destinationHandle.stat({ bigint: true });
      destinationIdentity = normalizeUploadDestinationIdentity(acquired);
      registerUploadDestination(file, resolvedDestination, acquired);
      ownsDestination = true;
      await copyBetweenOpenFiles(sourceHandle, destinationHandle);
      await destinationHandle.chmod(0o600);
      await destinationHandle.close();
      destinationHandle = null;
    }

    // A response-close cleanup may already have removed staging. Otherwise only
    // unlink the pathname if it still names the inode acquired above; a retry's
    // replacement is never ours to remove.
    await removeOwnedPathSafely(source, sourceStat);

    const currentDestination = await fs.lstat(resolvedDestination, { bigint: true });
    if (!destinationIdentity || !sameUploadDestinationIdentity(destinationIdentity, currentDestination)) {
      throw new HttpError(
        409,
        "UPLOAD_FILE_CHANGED",
        "Le fichier durable a été remplacé pendant son transfert."
      );
    }

    return resolvedDestination;
  } catch (error) {
    if (ownsDestination) {
      // This transfer has not returned successfully, hence no business write
      // can legitimately reference its pathname yet. Identity-aware cleanup
      // removes only our inode and preserves any concurrent replacement.
      await cleanupUploadsAfterConfirmedRollback([file]);
    }
    throw error;
  } finally {
    await (destinationHandle as Awaited<ReturnType<typeof fs.open>> | null)
      ?.close()
      .catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
}

/**
 * Promote one validated staging file into durable storage and transfer its
 * ownership to the transaction lifecycle. The Multer `path` intentionally
 * remains the staging ownership key; callers receive the durable path as the
 * return value while response cleanup can still address the original upload.
 */
export async function promoteSecureUpload(
  file: Express.Multer.File,
  finalDirectory: string,
  filename?: string
): Promise<string> {
  ensureSharedUploadDirectory(finalDirectory);
  const extension = path.extname(file.originalname).toLowerCase();
  const storedName = filename ?? `${randomUUID()}${extension}`;
  const destination = await transferSecureUploadToDestination(
    file,
    path.resolve(finalDirectory, storedName)
  );
  file.destination = path.resolve(finalDirectory);
  file.filename = storedName;
  return destination;
}

async function validateFiles(
  files: Express.Multer.File[],
  policy: UploadPolicy,
  signal: AbortSignal
): Promise<void> {
  throwIfUploadAborted(signal);
  if (files.length > policy.maxFiles) {
    throw new HttpError(400, "UPLOAD_TOO_MANY_FILES", `Vous pouvez envoyer au maximum ${policy.maxFiles} fichier(s) à la fois.`);
  }
  const hashes = new Set<string>();
  for (const file of files) {
    throwIfUploadAborted(signal);
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new HttpError(400, "UPLOAD_EMPTY_FILE", "Le fichier est vide. Sélectionnez un fichier contenant des données.");
    }
    if (file.size > policy.maxFileBytes) {
      throw new HttpError(413, "UPLOAD_FILE_TOO_LARGE", `Le fichier dépasse la limite de ${formatUploadLimit(policy.maxFileBytes)}.`);
    }
    const extension = assertPreflight(file, policy);
    const sample = await sampleFile(file, signal);
    if (isForbiddenExecutable(sample.head)) {
      throw new HttpError(415, "UPLOAD_EXECUTABLE_FORBIDDEN", "Les fichiers exécutables sont interdits.");
    }
    const contentMatches = extension && isStructurallyValidatedArchiveExtension(extension)
      ? await archiveMatchesExtension(extension, {
        ...(file.buffer ? { buffer: file.buffer } : { path: file.path }),
        size: file.size,
      }, signal)
      : !extension || contentMatchesExtension(extension, sample, file.size);
    throwIfUploadAborted(signal);
    if (!contentMatches) {
      throw new HttpError(415, "UPLOAD_SIGNATURE_MISMATCH", "Le contenu du fichier ne correspond pas à son extension.");
    }
    const digest = await sha256(file, signal);
    if (hashes.has(digest)) {
      throw new HttpError(409, "UPLOAD_DUPLICATE_FILE", "Le même fichier apparaît plusieurs fois dans cet envoi.");
    }
    hashes.add(digest);

    const scan = await scanUpload({
      ...(file.buffer ? { buffer: file.buffer } : { path: file.path }),
      signal,
    });
    throwIfUploadAborted(signal);
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

function ensurePrivateQuarantineDirectory(usage: UploadUsage): string {
  const directory = getTmpStoragePath("upload-quarantine", usage);
  return ensurePrivateUploadDirectory(directory, getTmpStoragePath());
}

function privateStagingStorage(
  directory: string,
  stagingPathsByRequest: WeakMap<Request, Set<string>>
): multer.StorageEngine {
  return {
    _handleFile(req, file, callback) {
      const filename = `${randomUUID()}.part`;
      const filePath = path.resolve(directory, filename);
      const writeAbortController = new AbortController();
      const abortWrite = () => {
        if (!writeAbortController.signal.aborted) writeAbortController.abort();
      };
      req.once("aborted", abortWrite);
      if (req.aborted) abortWrite();

      const closeDescriptor = (descriptor: number) => new Promise<Error | null>((resolve) => {
        nodeFs.close(descriptor, (error) => resolve(error));
      });
      const removePartial = () => new Promise<Error | null>((resolve) => {
        void cleanupStagingPaths([filePath]).then(
          (cleanup) => resolve(cleanup.failedCount > 0 ? new UploadDestinationCleanupError(1) : null),
          (error) => resolve(error instanceof Error ? error : new Error("Upload cleanup failure"))
        );
      });
      const openPrivateFile = () => new Promise<number>((resolve, reject) => {
        // Own the pathname and its permissions in one exclusive syscall.
        // Multer's stock disk storage uses 0666 & umask, which creates a local
        // disclosure window before post-receipt validation can run.
        nodeFs.open(filePath, "wx", 0o600, (error, descriptor) => {
          if (error) reject(error);
          else resolve(descriptor);
        });
      });

      let callbackSettled = false;
      const settle = (error?: Error, info?: Partial<Express.Multer.File>) => {
        if (callbackSettled) return;
        callbackSettled = true;
        callback(error, info);
      };

      void (async () => {
        let descriptor: number | null = null;
        let ownsPath = false;
        try {
          descriptor = await openPrivateFile();
          ownsPath = true;
          const opened = nodeFs.fstatSync(descriptor, { bigint: true });
          if (!opened.isFile()) throw uploadPrivateDirectoryUnavailable();
          secureStagingIdentities.set(filePath, normalizeUploadDestinationIdentity(opened));
          const requestPaths = stagingPathsByRequest.get(req) ?? new Set<string>();
          requestPaths.add(filePath);
          stagingPathsByRequest.set(req, requestPaths);

          if (writeAbortController.signal.aborted) throw new UploadRequestAbortedError();
          const output = nodeFs.createWriteStream(filePath, {
            fd: descriptor,
            autoClose: true,
          });
          descriptor = null; // The write stream now owns and closes the fd.
          await pipeline(file.stream, output, { signal: writeAbortController.signal });
          if (writeAbortController.signal.aborted) throw new UploadRequestAbortedError();

          return {
            destination: directory,
            filename,
            path: filePath,
            size: output.bytesWritten,
          } satisfies Partial<Express.Multer.File>;
        } catch (error) {
          const cleanupErrors: Error[] = [];
          if (descriptor !== null) {
            const closeError = await closeDescriptor(descriptor);
            if (closeError) cleanupErrors.push(closeError);
          }
          if (ownsPath) {
            const unlinkError = await removePartial();
            if (unlinkError) cleanupErrors.push(unlinkError);
          }
          if (cleanupErrors.length > 0) {
            logger.error("[UPLOAD_STAGING] partial write cleanup failed", JSON.stringify({
              error_codes: cleanupErrors.map((cleanupError) =>
                (cleanupError as NodeJS.ErrnoException).code ?? cleanupError.name
              ),
            }));
          }
          throw error;
        } finally {
          req.off("aborted", abortWrite);
        }
      })().then(
        (info) => settle(undefined, info),
        (error) => settle(error instanceof Error ? error : new Error("Upload staging failure"))
      );
    },
    _removeFile(_req, file, callback) {
      if (!file.path) {
        callback(null);
        return;
      }
      void cleanupStagingPaths([file.path]).then(
        (cleanup) => callback(cleanup.failedCount > 0 ? new UploadDestinationCleanupError(1) : null),
        (error) => callback(error instanceof Error ? error : new Error("Upload cleanup failure"))
      );
    },
  };
}

async function hardenStagingFilePermissions(files: readonly Express.Multer.File[]): Promise<void> {
  const results = await Promise.allSettled(files.map(async (file) => {
    const resolved = path.resolve(file.path);
    const identity = secureStagingIdentities.get(resolved);
    if (!identity) throw uploadPrivateDirectoryUnavailable();
    const handle = await fs.open(
      resolved,
      nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameUploadDestinationIdentity(identity, opened)) {
        throw uploadPrivateDirectoryUnavailable();
      }
      await handle.chmod(0o600);
      const secured = await handle.stat({ bigint: true });
      if (
        !sameUploadDestinationIdentity(identity, secured)
        // Windows chmod is only a read-only ACL approximation and does not
        // expose POSIX 0600 through stat(). The exclusive fd/inode check still
        // prevents pathname substitution there; Linux enforces the exact mode.
        || (process.platform !== "win32" && (Number(secured.mode) & 0o777) !== 0o600)
      ) {
        throw uploadPrivateDirectoryUnavailable();
      }
    } finally {
      await handle.close();
    }
  }));
  if (results.some((result) => result.status === "rejected")) {
    throw new HttpError(
      503,
      "UPLOAD_STAGING_PERMISSION_FAILED",
      "Le stockage temporaire sécurisé est indisponible. Réessayez plus tard."
    );
  }
}

export function createSecureUpload(usage: UploadUsage, options: SecureUploadOptions = {}): SecureUpload {
  const basePolicy = getUploadPolicy(usage);
  const policy: UploadPolicy = options.maxFiles
    ? Object.freeze({ ...basePolicy, maxFiles: Math.min(options.maxFiles, basePolicy.maxFiles) })
    : basePolicy;
  const storage = options.storage ?? "staging";
  const isMemory = storage === "memory";
  const stagingPathsByRequest = new WeakMap<Request, Set<string>>();
  const quarantineDirectory = isMemory ? null : ensurePrivateQuarantineDirectory(usage);
  const stagingStorage = isMemory ? null : privateStagingStorage(quarantineDirectory!, stagingPathsByRequest);

  const makeMulter = (maxFiles: number) =>
    multer({
      storage: isMemory
        ? multer.memoryStorage()
        : stagingStorage!,
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
      const stagedPaths = Array.from(new Set([
        ...(stagingPathsByRequest.get(req) ?? []),
        ...files.filter((file) => !!file.path).map((file) => file.path),
      ]));
      stagingPathsByRequest.delete(req);
      const abortController = new AbortController();
      let requestAborted = req.aborted || res.destroyed;
      let validationSettled = false;
      let settleValidationPromise!: () => void;
      const validationDone = new Promise<void>((resolve) => { settleValidationPromise = resolve; });
      let cleanupPromise: Promise<StagingCleanupResult> | null = null;
      let cleanupAudited = false;
      let ownershipReleased = false;

      const abortObserved = () => requestAborted || req.aborted || (res.destroyed && !res.writableEnded);

      const settleValidation = () => {
        if (validationSettled) return;
        validationSettled = true;
        settleValidationPromise();
      };

      const cleanupStagingAndAudit = async () => {
        const cleanup = await cleanupStagingPaths(stagedPaths);
        if (cleanup.attemptedCount === 0) return cleanup;
        cleanupAudited = true;
        auditUpload(req, usage, cleanup.failedCount > 0 ? "cleanup_failed" : "cleaned", {
          staged_count: cleanup.attemptedCount,
          failed_count: cleanup.failedCount,
        });
        return cleanup;
      };

      const releaseOwnershipOnce = () => {
        if (ownershipReleased) return;
        ownershipReleased = true;
        const ownership = releaseRegisteredUploadDestinations(files);
        const uncertain = ownership.filter((record) =>
          record.state === "transferred" ||
          record.state === "commit-attempted" ||
          record.state === "commit-uncertain" ||
          record.state === "rollback-uncertain"
        );
        if (uncertain.length > 0) {
          logger.error("[UPLOAD_OWNERSHIP] durable destination preserved for reconciliation", JSON.stringify({
            state_counts: ownership.reduce<Record<string, number>>((counts, record) => {
              counts[record.state] = (counts[record.state] ?? 0) + 1;
              return counts;
            }, {}),
            response_status: res.statusCode,
            response_ended: res.writableEnded,
          }));
        }
      };

      const detachLifecycleListeners = () => {
        req.off("aborted", cleanupAfterAbort);
        res.off("finish", cleanupAfterResponse);
        res.off("close", cleanupAfterClose);
      };

      const requestCleanup = (): Promise<StagingCleanupResult> => {
        releaseOwnershipOnce();
        if (!cleanupPromise) {
          // Abort first stops hash/scanner handles. Cleanup then waits for the
          // validation frame to unwind, avoiding a Windows unlink race and
          // producing exactly one truthful audit event for this request.
          cleanupPromise = (async () => {
            await validationDone;
            return cleanupStagingAndAudit();
          })().catch((error) => {
            const attemptedCount = new Set(stagedPaths).size;
            if (!cleanupAudited && attemptedCount > 0) {
              cleanupAudited = true;
              try {
                auditUpload(req, usage, "cleanup_failed", {
                  staged_count: attemptedCount,
                  failed_count: attemptedCount,
                });
              } catch {
                // The cleanup promise must never become an unhandled rejection
                // from an HTTP lifecycle event.
              }
            }
            try {
              logger.error("[UPLOAD_CLEANUP] staging cleanup task failed", JSON.stringify({
                error: error instanceof Error ? error.name : "unknown",
                staged_count: attemptedCount,
              }));
            } catch {
              // Logging failure must not re-reject a fire-and-forget callback.
            }
            return { attemptedCount, failedCount: attemptedCount };
          }).finally(detachLifecycleListeners);
        }
        return cleanupPromise;
      };

      function cleanupAfterResponse(): void {
        void requestCleanup();
      }

      function cleanupAfterAbort(): void {
        requestAborted = true;
        if (!abortController.signal.aborted) abortController.abort();
        void requestCleanup();
      }

      function cleanupAfterClose(): void {
        if (!res.writableEnded) cleanupAfterAbort();
        else cleanupAfterResponse();
      }

      // Multer has finished receiving the body, but validation may still spend
      // time hashing or scanning it. Arm lifecycle cleanup before that work so
      // a disconnect cannot strand staging or a late ownership registration.
      if (files.length > 0) {
        req.once("aborted", cleanupAfterAbort);
        res.once("finish", cleanupAfterResponse);
        res.once("close", cleanupAfterClose);
      }
      if (req.aborted || res.destroyed) cleanupAfterAbort();

      try {
        if (uploadError) throw translateMulterError(uploadError, policy);
        if (!isMemory) await hardenStagingFilePermissions(files);
        throwIfUploadAborted(abortController.signal);
        await validateFiles(files, policy, abortController.signal);
        throwIfUploadAborted(abortController.signal);
        settleValidation();
        auditUpload(req, usage, "accepted", {
          file_count: files.length,
          total_bytes: files.reduce((sum, file) => sum + file.size, 0),
          scan_statuses: Array.from(new Set(files.map((file) => file.uploadSecurity?.scanStatus ?? "unknown"))),
        });
        next();
      } catch (error) {
        settleValidation();
        await requestCleanup();
        if (abortObserved() || error instanceof UploadRequestAbortedError || abortController.signal.aborted) return;
        auditUpload(req, usage, "rejected", {
          code: error instanceof HttpError ? error.code : "UPLOAD_INTERNAL_ERROR",
          file_count: files.length,
        });
        next(error);
      } finally {
        settleValidation();
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
