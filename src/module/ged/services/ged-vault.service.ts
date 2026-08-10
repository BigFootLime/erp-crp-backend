// GED centrale CERP (ADR-0037) — coffre documentaire.
//
// Le coffre stocke des blobs sous un nom dérivé de leur empreinte, sans aucune
// sémantique métier :
//
//     <racine>/vault/sha256/ab/cd/<empreinte>
//
// Conséquences voulues : renommer une pièce ne déplace aucun fichier, un même
// plan partagé par douze OF est stocké une fois, et personne ne peut deviner un
// chemin depuis une référence métier.
//
// Règle non négociable, et c'est elle qui manquait au reste du système : si la
// racine du coffre n'est pas disponible, on ÉCHOUE. On ne crée jamais un
// répertoire local de repli que personne ne sauvegarderait.

import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { HttpError } from "../../../utils/httpError";
import { isPathInsideDirectory } from "../../../utils/cerpStorage";
import {
  cleanupUploadsAfterConfirmedRollback,
  ensurePrivateUploadDirectory,
  registerUploadDestination,
  removeOwnedPathSafely,
} from "../../../shared/uploads/secure-upload";

const VAULT_SUBDIR = "vault";
const STAGING_SUBDIR = "staging";
const SENTINEL_DEFAULT_NAME = ".cerp-ged-volume";

export type VaultHealth = {
  configured: boolean;
  root_present: boolean;
  sentinel_required: boolean;
  sentinel_present: boolean;
  writable: boolean;
  healthy: boolean;
  detail: string | null;
  capacity_bytes: number | null;
  available_bytes: number | null;
  used_ratio: number | null;
  inode_total: number | null;
  inode_free: number | null;
};

function cleanEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Racine du coffre. Contrairement à `getCerpRootPath()`, il n'y a AUCUN repli :
 * une variable absente est une erreur de configuration, pas une invitation à
 * écrire dans le répertoire courant.
 */
export function getVaultRoot(): string {
  const configured = cleanEnv(process.env.CERP_GED_VAULT_ROOT);
  if (!configured) {
    throw new HttpError(
      503,
      "GED_VAULT_UNAVAILABLE",
      "Le coffre documentaire n'est pas configuré (CERP_GED_VAULT_ROOT absent)."
    );
  }
  return path.resolve(configured);
}

export function isVaultConfigured(): boolean {
  return cleanEnv(process.env.CERP_GED_VAULT_ROOT) !== null;
}

/**
 * Sentinelle : un fichier marqueur qui identifie le bon volume. Sans elle, un
 * montage absent laisserait écrire dans le point de montage vide du disque
 * système — exactement le scénario que la GED doit rendre impossible.
 *
 * `CERP_GED_REQUIRE_SENTINEL=false` n'est acceptable qu'en développement.
 */
function sentinelRequired(): boolean {
  const raw = cleanEnv(process.env.CERP_GED_REQUIRE_SENTINEL);
  if (raw === null) return process.env.NODE_ENV === "production";
  return raw.toLowerCase() !== "false" && raw !== "0";
}

function sentinelPath(root: string): string {
  const configured = cleanEnv(process.env.CERP_GED_SENTINEL);
  return configured ? path.resolve(configured) : path.join(root, "..", SENTINEL_DEFAULT_NAME);
}

async function assertSentinel(root: string): Promise<void> {
  if (!sentinelRequired()) return;
  try {
    await fs.access(sentinelPath(root));
  } catch {
    throw new HttpError(
      503,
      "GED_VAULT_UNAVAILABLE",
      "Le volume documentaire attendu n'est pas monté (sentinelle absente)."
    );
  }
}

/** Prépare et vérifie la racine du coffre. Lève 503 plutôt que de se rabattre. */
export async function ensureVaultReady(): Promise<string> {
  const root = getVaultRoot();
  await assertSentinel(root);
  try {
    ensurePrivateUploadDirectory(path.join(root, VAULT_SUBDIR), root);
    ensurePrivateUploadDirectory(path.join(root, STAGING_SUBDIR), root);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "accès impossible";
    throw new HttpError(
      503,
      "GED_VAULT_UNAVAILABLE",
      `Le coffre documentaire est inaccessible en écriture : ${detail}`
    );
  }
  return root;
}

/* -------------------------------------------------------------------------- */
/* Clés de stockage                                                            */
/* -------------------------------------------------------------------------- */

export function computeSha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function computeFileHandleSha256(handle: FileHandle): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = handle.createReadStream({ start: 0, autoClose: false });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function copyFileHandle(source: FileHandle, destination: FileHandle): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(
        buffer,
        written,
        bytesRead - written,
        position + written
      );
      if (result.bytesWritten <= 0) {
        throw Object.assign(new Error("GED vault copy made no progress"), { code: "EIO" });
      }
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  await destination.sync();
}

/** Clé interne opaque, relative à la racine. N'est jamais retournée par l'API. */
export function storageKeyForSha256(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new HttpError(500, "GED_VAULT_KEY", "Empreinte invalide pour une clé de coffre.");
  }
  return `${VAULT_SUBDIR}/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

function resolveInsideVault(root: string, storageKey: string): string {
  const absolute = path.resolve(root, storageKey);
  if (!isPathInsideDirectory(root, absolute)) {
    throw new HttpError(400, "GED_VAULT_PATH", "Chemin de stockage invalide.");
  }
  return absolute;
}

/* -------------------------------------------------------------------------- */
/* Écriture et lecture                                                        */
/* -------------------------------------------------------------------------- */

export type WrittenBlob = {
  sha256: string;
  storage_key: string;
  size_bytes: number;
  deduplicated: boolean;
  ownership: VaultBlobOwnership;
};

export type VaultBlobOwnership =
  | Readonly<{
      kind: "created";
      destination: string;
      dev: string;
      ino: string;
    }>
  | Readonly<{ kind: "deduplicated" }>;

function vaultIdentityMatches(
  ownership: Extract<VaultBlobOwnership, { kind: "created" }>,
  stat: Readonly<{ dev: string | number | bigint; ino: string | number | bigint }>
): boolean {
  return ownership.dev === String(stat.dev) && ownership.ino === String(stat.ino);
}

type VaultIdentityInput = Readonly<{
  dev: string | number | bigint;
  ino: string | number | bigint;
}>;

function createdVaultOwnership(
  destination: string,
  identity: VaultIdentityInput
): Extract<VaultBlobOwnership, { kind: "created" }> {
  return {
    kind: "created",
    destination,
    dev: String(identity.dev),
    ino: String(identity.ino),
  };
}

async function assertVaultPathIdentity(
  destination: string,
  identity: VaultIdentityInput
): Promise<void> {
  let current;
  try {
    current = await fs.lstat(destination, { bigint: true });
  } catch {
    throw new HttpError(
      409,
      "GED_FILE_CHANGED",
      "Le blob du coffre a changé pendant sa publication."
    );
  }
  if (
    !current.isFile()
    || String(current.dev) !== String(identity.dev)
    || String(current.ino) !== String(identity.ino)
  ) {
    throw new HttpError(
      409,
      "GED_FILE_CHANGED",
      "Le blob du coffre a été remplacé pendant sa publication."
    );
  }
}

/**
 * Delete only the exact vault inode created by this writer. Reference checks
 * and the shared SHA lock are the caller's responsibility.
 */
export async function cleanupOwnedVaultBlob(ownership: VaultBlobOwnership): Promise<void> {
  if (ownership.kind === "deduplicated") return;
  await removeOwnedPathSafely(ownership.destination, ownership);
}

function mapVaultWriteError(error: unknown): unknown {
  if ((error as NodeJS.ErrnoException)?.code === "ENOSPC") {
    return new HttpError(507, "GED_VAULT_FULL", "Le coffre documentaire est plein.");
  }
  if ((error as NodeJS.ErrnoException)?.code === "EROFS") {
    return new HttpError(503, "GED_VAULT_UNAVAILABLE", "Le coffre documentaire est en lecture seule.");
  }
  return error;
}

/**
 * Écrit un blob. Le contenu étant adressé par son empreinte, deux dépôts
 * identiques convergent naturellement vers le même fichier : `EEXIST` n'est pas
 * une erreur, c'est de la déduplication.
 *
 * Le buffer est d'abord écrit intégralement dans un staging privé `0600`, puis
 * publié par lien dur exclusif. Le nom final n'existe donc jamais à l'état
 * partiel, même si l'écriture échoue avec ENOSPC.
 */
export async function writeBlob(buffer: Buffer): Promise<WrittenBlob> {
  const snapshot = Buffer.from(buffer);
  const root = await ensureVaultReady();
  const sha256 = computeSha256(snapshot);
  const storageKey = storageKeyForSha256(sha256);
  const destination = resolveInsideVault(root, storageKey);
  const stagingDirectory = path.join(root, STAGING_SUBDIR, "buffer");
  const stagingPath = path.join(stagingDirectory, `${crypto.randomUUID()}.part`);

  ensurePrivateUploadDirectory(path.dirname(destination), path.join(root, VAULT_SUBDIR));
  ensurePrivateUploadDirectory(stagingDirectory, path.join(root, STAGING_SUBDIR));

  let stagingHandle: FileHandle | null = null;
  let createdOwnership: Extract<VaultBlobOwnership, { kind: "created" }> | null = null;
  let result: WrittenBlob | null = null;
  let primaryError: unknown = null;
  try {
    stagingHandle = await fs.open(stagingPath, "wx", 0o600);
    await stagingHandle.writeFile(snapshot);
    await stagingHandle.sync();
    const stagingStat = await stagingHandle.stat({ bigint: true });
    await stagingHandle.close();
    stagingHandle = null;

    let created = false;
    try {
      await fs.link(stagingPath, destination);
      created = true;
      createdOwnership = {
        kind: "created",
        destination,
        dev: String(stagingStat.dev),
        ino: String(stagingStat.ino),
      };
    } catch (publishError) {
      if ((publishError as NodeJS.ErrnoException).code !== "EEXIST") throw publishError;
    }

    if (createdOwnership) await assertVaultPathIdentity(destination, createdOwnership);
    const storedHash = await computeFileSha256(destination);
    if (storedHash !== sha256) {
      throw new HttpError(
        409,
        "GED_INTEGRITY",
        "Le contenu déjà présent dans le coffre ne correspond pas à son empreinte."
      );
    }
    if (createdOwnership) await assertVaultPathIdentity(destination, createdOwnership);

    const ownership: VaultBlobOwnership = createdOwnership ?? { kind: "deduplicated" };
    result = {
      sha256,
      storage_key: storageKey,
      size_bytes: snapshot.byteLength,
      deduplicated: !created,
      ownership,
    };
  } catch (error) {
    primaryError = mapVaultWriteError(error);
  } finally {
    await stagingHandle?.close().catch(() => undefined);
  }

  let stagingCleanupError: unknown = null;
  try {
    await fs.unlink(stagingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") stagingCleanupError = error;
  }

  if (primaryError || stagingCleanupError) {
    if (createdOwnership) {
      try {
        await cleanupOwnedVaultBlob(createdOwnership);
      } catch (cleanupError) {
        throw new HttpError(
          503,
          "GED_BLOB_CLEANUP_UNCERTAIN",
          "Le nettoyage du blob GED n'a pas pu être confirmé."
        );
      }
    }
    if (stagingCleanupError) {
      throw new HttpError(
        503,
        "GED_VAULT_STAGING_CLEANUP_FAILED",
        "Le nettoyage du staging GED n'a pas pu être confirmé."
      );
    }
    throw primaryError;
  }

  if (!result) throw new Error("GED buffer blob writer returned no result");
  return result;
}

/**
 * Move a staged HTTP upload into the content-addressed vault with bounded
 * memory. A hard link is used on the same filesystem; EXDEV falls back to a
 * streamed exclusive copy. The durable path is never overwritten.
 */
export async function writeBlobFromPath(
  sourceFile: Readonly<{ path: string }>,
  expectedSha256?: string
): Promise<WrittenBlob> {
  const sourcePath = path.resolve(sourceFile.path);
  const root = await ensureVaultReady();
  let sourceHandle: FileHandle | null = null;
  let destinationHandle: FileHandle | null = null;
  let created = false;
  let createdIdentity: Extract<VaultBlobOwnership, { kind: "created" }> | null = null;
  try {
    try {
      sourceHandle = await fs.open(sourcePath, "r");
    } catch {
      throw new HttpError(400, "GED_FILE_REQUIRED", "Le fichier déposé est introuvable.");
    }
    const sourceStat = await sourceHandle.stat({ bigint: true });
    if (!sourceStat.isFile()) {
      throw new HttpError(400, "GED_FILE_REQUIRED", "Le fichier déposé est introuvable.");
    }

    const sha256 = await computeFileHandleSha256(sourceHandle);
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw new HttpError(
        409,
        "GED_FILE_CHANGED",
        "Le fichier déposé a changé après son contrôle de sécurité."
      );
    }
    const storageKey = storageKeyForSha256(sha256);
    const destination = resolveInsideVault(root, storageKey);
    ensurePrivateUploadDirectory(path.dirname(destination), path.join(root, VAULT_SUBDIR));

    try {
      await fs.link(sourcePath, destination);
      created = true;
      createdIdentity = createdVaultOwnership(destination, sourceStat);
      // A successful link must publish the inode held by sourceHandle. Transfer
      // that exact identity synchronously before any fallible open/chmod/hash.
      registerUploadDestination(sourceFile, destination, sourceStat);
      destinationHandle = await fs.open(destination, "r");
      const acquired = await destinationHandle.stat({ bigint: true });
      if (!vaultIdentityMatches(createdIdentity, acquired)) {
        throw new HttpError(
          409,
          "GED_FILE_CHANGED",
          "Le blob du coffre a été remplacé pendant sa publication."
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (created) {
        throw error;
      } else if (code === "EEXIST") {
        created = false;
      } else if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP") {
        try {
          destinationHandle = await fs.open(destination, "wx", 0o600);
          created = true;
        } catch (openError) {
          if ((openError as NodeJS.ErrnoException).code !== "EEXIST") throw openError;
          created = false;
        }

        if (destinationHandle) {
          const acquired = await destinationHandle.stat({ bigint: true });
          createdIdentity = createdVaultOwnership(destination, acquired);
          // fs.open("wx") is the exclusive creation point for EXDEV copies.
          // Register its fstat identity before the first byte is copied so a
          // partial write remains compensable but a replacement never is.
          registerUploadDestination(sourceFile, destination, acquired);
          await copyFileHandle(sourceHandle, destinationHandle);
        }
      } else {
        throw error;
      }
    }

    if (!destinationHandle) destinationHandle = await fs.open(destination, "r");
    const acquiredDestination = await destinationHandle.stat({ bigint: true });
    if (createdIdentity && !vaultIdentityMatches(createdIdentity, acquiredDestination)) {
      throw new HttpError(
        409,
        "GED_FILE_CHANGED",
        "Le blob du coffre a été remplacé pendant sa publication."
      );
    }
    await assertVaultPathIdentity(destination, acquiredDestination);
    if (created) await destinationHandle.chmod(0o600);

    const storedHash = await computeFileHandleSha256(destinationHandle);
    if (storedHash !== sha256) {
      throw new HttpError(409, "GED_INTEGRITY", "Le blob du coffre ne correspond pas à son empreinte.");
    }
    await assertVaultPathIdentity(destination, acquiredDestination);
    await destinationHandle.close();
    destinationHandle = null;

    await removeOwnedPathSafely(sourcePath, sourceStat);
    return {
      sha256,
      storage_key: storageKey,
      size_bytes: Number(sourceStat.size),
      deduplicated: !created,
      ownership: createdIdentity ?? { kind: "deduplicated" },
    };
  } catch (err) {
    if (created) {
      try {
        // The promotion did not complete and no metadata mutation can yet
        // reference this newly owned destination. GED callers also still hold
        // the SHA advisory lock here. Strict central cleanup either removes the
        // destination or preserves a retryable registry record and throws a
        // privacy-safe 503 for reconciliation.
        await cleanupUploadsAfterConfirmedRollback([sourceFile]);
      } catch (cleanupError) {
        throw cleanupError;
      }
    }
    if ((err as NodeJS.ErrnoException)?.code === "ENOSPC") {
      throw new HttpError(507, "GED_VAULT_FULL", "Le coffre documentaire est plein.");
    }
    if ((err as NodeJS.ErrnoException)?.code === "EROFS") {
      throw new HttpError(503, "GED_VAULT_UNAVAILABLE", "Le coffre documentaire est en lecture seule.");
    }
    throw err;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
}

export async function resolveBlobForDownload(storageKey: string): Promise<{ file_path: string; allowed_root: string }> {
  const root = await ensureVaultReady();
  return { file_path: resolveInsideVault(root, storageKey), allowed_root: root };
}

/**
 * Lit un blob et REVÉRIFIE son empreinte. Un fichier altéré sur disque est
 * refusé, jamais servi : c'est ce qui distingue un coffre d'un répertoire.
 */
export async function readBlob(storageKey: string, expectedSha256: string): Promise<Buffer> {
  const root = await ensureVaultReady();
  const source = resolveInsideVault(root, storageKey);

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(source);
  } catch {
    throw new HttpError(404, "GED_BLOB_NOT_FOUND", "Le contenu documentaire est introuvable.");
  }

  if (computeSha256(buffer) !== expectedSha256) {
    throw new HttpError(
      409,
      "GED_INTEGRITY",
      "L'intégrité du document ne peut pas être vérifiée. Le contenu ne sera pas servi."
    );
  }
  return buffer;
}

/* -------------------------------------------------------------------------- */
/* Supervision                                                                */
/* -------------------------------------------------------------------------- */

export async function checkVaultHealth(): Promise<VaultHealth> {
  const configured = isVaultConfigured();
  if (!configured) {
    return {
      configured: false,
      root_present: false,
      sentinel_required: sentinelRequired(),
      sentinel_present: false,
      writable: false,
      healthy: false,
      detail: "CERP_GED_VAULT_ROOT n'est pas configuré.",
      capacity_bytes: null,
      available_bytes: null,
      used_ratio: null,
      inode_total: null,
      inode_free: null,
    };
  }

  const root = getVaultRoot();
  let rootPresent = false;
  let sentinelPresent = false;
  let writable = false;
  let detail: string | null = null;
  let capacityBytes: number | null = null;
  let availableBytes: number | null = null;
  let usedRatio: number | null = null;
  let inodeTotal: number | null = null;
  let inodeFree: number | null = null;

  try {
    const stat = await fs.stat(root);
    rootPresent = stat.isDirectory();
  } catch {
    detail = "La racine du coffre est absente ou inaccessible.";
  }

  try {
    await fs.access(sentinelPath(root));
    sentinelPresent = true;
  } catch {
    if (sentinelRequired() && detail === null) {
      detail = "Sentinelle de volume absente : le montage attendu n'est pas en place.";
    }
  }

  if (rootPresent) {
    try {
      ensurePrivateUploadDirectory(path.join(root, VAULT_SUBDIR), root);
      writable = true;
    } catch {
      if (detail === null) detail = "Le coffre n'est pas accessible en écriture.";
    }
    try {
      const capacity = await fs.statfs(root);
      capacityBytes = capacity.blocks * capacity.bsize;
      availableBytes = capacity.bavail * capacity.bsize;
      usedRatio = capacityBytes > 0 ? (capacityBytes - availableBytes) / capacityBytes : null;
      inodeTotal = capacity.files;
      inodeFree = capacity.ffree;
    } catch {
      if (detail === null) detail = "La capacité disponible du coffre ne peut pas être mesurée.";
    }
  }

  const healthy = rootPresent && writable && (!sentinelRequired() || sentinelPresent);
  return {
    configured: true,
    root_present: rootPresent,
    sentinel_required: sentinelRequired(),
    sentinel_present: sentinelPresent,
    writable,
    healthy,
    detail: healthy ? null : detail,
    capacity_bytes: capacityBytes,
    available_bytes: availableBytes,
    used_ratio: usedRatio,
    inode_total: inodeTotal,
    inode_free: inodeFree,
  };
}
