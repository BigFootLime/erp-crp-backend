import pool from "../../../config/database";
import { normalizeStoredImagePath } from "../../../utils/imageStorage";

export type OperationalMediaAsset = Readonly<{ id: string; storage_key: string; mime_type: string | null; sha256: string | null; status: "ACTIVE" | "REVOKED" | "QUARANTINED" | "LEGACY_UNVERIFIED"; owner_type: string; owner_id: string; module_key: string }>;

export type OperationalMediaOwnerType =
  | "machine"
  | "client"
  | "fournisseur"
  | "outil"
  | "outil_famille"
  | "outil_geometrie"
  | "outil_fabricant"
  | "user";

export async function findOperationalMediaAssets(id: string): Promise<OperationalMediaAsset[]> {
  const result = await pool.query<OperationalMediaAsset>(`
    SELECT a.id::text AS id, a.storage_key, a.mime_type, a.sha256, a.status, b.owner_type, b.owner_id, b.module_key
    FROM public.operational_media_assets a
    INNER JOIN public.operational_media_bindings b ON b.asset_id = a.id
    WHERE a.id = $1
    ORDER BY b.created_at ASC`, [id]);
  return result.rows;
}

/**
 * Revalidate the legacy parent before reading a file. These lookups deliberately
 * mirror the existing detail-read lifecycle: machine/client archive state does
 * not erase their parent rows, so an archive alone is not a new media denial.
 */
export async function operationalMediaOwnerExists(
  ownerType: OperationalMediaOwnerType,
  ownerId: string,
): Promise<boolean> {
  const statementByOwner: Record<OperationalMediaOwnerType, { sql: string; values: unknown[] }> = {
    machine: { sql: "SELECT 1 FROM public.machines WHERE id = $1::uuid LIMIT 1", values: [ownerId] },
    client: { sql: "SELECT 1 FROM public.clients WHERE client_id = $1 LIMIT 1", values: [ownerId] },
    fournisseur: { sql: "SELECT 1 FROM public.fournisseurs WHERE id = $1::uuid LIMIT 1", values: [ownerId] },
    outil: { sql: "SELECT 1 FROM public.gestion_outils_outil WHERE id_outil = $1::integer LIMIT 1", values: [ownerId] },
    outil_famille: { sql: "SELECT 1 FROM public.gestion_outils_famille WHERE id_famille = $1::integer LIMIT 1", values: [ownerId] },
    outil_geometrie: { sql: "SELECT 1 FROM public.gestion_outils_geometrie WHERE id_geometrie = $1::integer LIMIT 1", values: [ownerId] },
    outil_fabricant: { sql: "SELECT 1 FROM public.gestion_outils_fabricant WHERE id_fabricant = $1::integer LIMIT 1", values: [ownerId] },
    user: { sql: "SELECT 1 FROM public.users WHERE id = $1::integer AND COALESCE(NULLIF(lower(trim(status)), ''), 'active') NOT IN ('inactive', 'blocked', 'suspended') LIMIT 1", values: [ownerId] },
  };
  const statement = statementByOwner[ownerType];
  const result = await pool.query(statement.sql, statement.values);
  return result.rowCount !== 0;
}

/** Bulk DTO projection for legacy repositories. Storage keys never leave this layer. */
export async function findAssetIdsByStorageKeys(keys: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const normalized = [...new Set(keys.map(normalizeStoredImagePath).filter((key): key is string => !!key && !/^https?:\/\//i.test(key)))];
  if (!normalized.length) return new Map();
  const result = await pool.query<{ storage_key: string; id: string }>(
    `SELECT storage_key, id::text AS id FROM public.operational_media_assets
      WHERE storage_key = ANY($1::text[]) AND status = 'ACTIVE' AND scan_status = 'CLEAN'
        AND mime_type IN ('image/png','image/jpeg','image/webp','image/gif') AND sha256 IS NOT NULL AND size_bytes IS NOT NULL`,
    [normalized]
  );
  return new Map(result.rows.map((row) => [row.storage_key, row.id]));
}

/** Plan and sketch fields may additionally expose a verified PDF. Do not use
 * this projection for image-only UI surfaces. */
export async function findDocumentAssetIdsByStorageKeys(keys: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const normalized = [...new Set(keys.map(normalizeStoredImagePath).filter((key): key is string => !!key && !/^https?:\/\//i.test(key)))];
  if (!normalized.length) return new Map();
  const result = await pool.query<{ storage_key: string; id: string }>(
    `SELECT storage_key, id::text AS id FROM public.operational_media_assets
      WHERE storage_key = ANY($1::text[]) AND status = 'ACTIVE' AND scan_status = 'CLEAN'
        AND mime_type IN ('image/png','image/jpeg','image/webp','image/gif','application/pdf') AND sha256 IS NOT NULL AND size_bytes IS NOT NULL`,
    [normalized]
  );
  return new Map(result.rows.map((row) => [row.storage_key, row.id]));
}

export function mediaFilename(asset: OperationalMediaAsset): string {
  // Never reflect a physical or legacy storage basename into a response
  // header: old names can contain customer, machine or project information.
  // The MIME-derived extension is sufficient for a browser/client while the
  // opaque asset UUID remains the only public identity.
  const extension = asset.mime_type === "image/png"
    ? ".png"
    : asset.mime_type === "image/jpeg"
      ? ".jpg"
    : asset.mime_type === "image/webp"
      ? ".webp"
      : asset.mime_type === "image/gif"
        ? ".gif"
      : asset.mime_type === "application/pdf"
        ? ".pdf"
        : "";
  return `media-${asset.id}${extension}`;
}
