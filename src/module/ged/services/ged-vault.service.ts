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
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { HttpError } from "../../../utils/httpError";
import { isPathInsideDirectory } from "../../../utils/cerpStorage";
import { registerUploadDestination } from "../../../shared/uploads/secure-upload";

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
    await fs.mkdir(path.join(root, VAULT_SUBDIR), { recursive: true });
    await fs.mkdir(path.join(root, STAGING_SUBDIR), { recursive: true });
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
};

/**
 * Écrit un blob. Le contenu étant adressé par son empreinte, deux dépôts
 * identiques convergent naturellement vers le même fichier : `EEXIST` n'est pas
 * une erreur, c'est de la déduplication.
 *
 * `flag: "wx"` garantit qu'un blob existant n'est jamais écrasé.
 */
export async function writeBlob(buffer: Buffer): Promise<WrittenBlob> {
  const root = await ensureVaultReady();
  const sha256 = computeSha256(buffer);
  const storageKey = storageKeyForSha256(sha256);
  const destination = resolveInsideVault(root, storageKey);

  await fs.mkdir(path.dirname(destination), { recursive: true });

  try {
    await fs.writeFile(destination, buffer, { flag: "wx" });
    return { sha256, storage_key: storageKey, size_bytes: buffer.byteLength, deduplicated: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      // Le contenu est déjà présent : on vérifie qu'il est bien identique avant
      // de le réutiliser. Une collision de taille signalerait une corruption.
      const existing = await fs.readFile(destination);
      if (computeSha256(existing) !== sha256) {
        throw new HttpError(
          409,
          "GED_INTEGRITY",
          "Le contenu déjà présent dans le coffre ne correspond pas à son empreinte."
        );
      }
      return { sha256, storage_key: storageKey, size_bytes: buffer.byteLength, deduplicated: true };
    }
    if ((err as NodeJS.ErrnoException)?.code === "ENOSPC") {
      throw new HttpError(507, "GED_VAULT_FULL", "Le coffre documentaire est plein.");
    }
    if ((err as NodeJS.ErrnoException)?.code === "EROFS") {
      throw new HttpError(503, "GED_VAULT_UNAVAILABLE", "Le coffre documentaire est en lecture seule.");
    }
    throw err;
  }
}

/**
 * Move a staged HTTP upload into the content-addressed vault with bounded
 * memory. A hard link is used on the same filesystem; EXDEV falls back to a
 * streamed exclusive copy. The durable path is never overwritten.
 */
export async function writeBlobFromPath(sourcePath: string): Promise<WrittenBlob> {
  const root = await ensureVaultReady();
  const sourceStat = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStat?.isFile()) {
    throw new HttpError(400, "GED_FILE_REQUIRED", "Le fichier déposé est introuvable.");
  }

  const sha256 = await computeFileSha256(sourcePath);
  const storageKey = storageKeyForSha256(sha256);
  const destination = resolveInsideVault(root, storageKey);
  await fs.mkdir(path.dirname(destination), { recursive: true });

  let created = false;
  try {
    try {
      await fs.link(sourcePath, destination);
      created = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        created = false;
      } else if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP") {
        try {
          await pipeline(
            createReadStream(sourcePath),
            createWriteStream(destination, { flags: "wx", mode: 0o600 })
          );
          created = true;
        } catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") {
            await fs.unlink(destination).catch(() => undefined);
            throw copyError;
          }
          created = false;
        }
      } else {
        throw error;
      }
    }

    const storedHash = await computeFileSha256(destination);
    if (storedHash !== sha256) {
      if (created) await fs.unlink(destination).catch(() => undefined);
      throw new HttpError(409, "GED_INTEGRITY", "Le blob du coffre ne correspond pas à son empreinte.");
    }

    if (created) {
      await fs.chmod(destination, 0o600).catch(() => undefined);
      registerUploadDestination({ path: sourcePath }, destination);
    }
    await fs.unlink(sourcePath).catch(() => undefined);
    return {
      sha256,
      storage_key: storageKey,
      size_bytes: sourceStat.size,
      deduplicated: !created,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOSPC") {
      throw new HttpError(507, "GED_VAULT_FULL", "Le coffre documentaire est plein.");
    }
    if ((err as NodeJS.ErrnoException)?.code === "EROFS") {
      throw new HttpError(503, "GED_VAULT_UNAVAILABLE", "Le coffre documentaire est en lecture seule.");
    }
    throw err;
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
    };
  }

  const root = getVaultRoot();
  let rootPresent = false;
  let sentinelPresent = false;
  let writable = false;
  let detail: string | null = null;

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
      await fs.mkdir(path.join(root, VAULT_SUBDIR), { recursive: true });
      writable = true;
    } catch {
      if (detail === null) detail = "Le coffre n'est pas accessible en écriture.";
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
  };
}
