import path from "node:path";
import { resolveAccessProfile } from "../../access-control/services/access-control.service";
import { getImagesRootPath } from "../../../utils/imageStorage";
import { HttpError } from "../../../utils/httpError";
import { checkOperationalMediaStorage } from "./operational-media-health.service";
import {
  findOperationalMediaAssets,
  operationalMediaOwnerExists,
  type OperationalMediaAsset,
  type OperationalMediaOwnerType,
} from "../repository/operational-media.repository";

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"]);

type OwnerPolicy = Readonly<{ moduleKey: "production" | "clients" | "outillage" | "fournisseurs" }> | Readonly<{ authenticatedActiveUser: true }>;

// This is intentionally a small, closed registry rather than a generic table
// name derived from a binding. It protects the new asset authority from both
// unknown owner types and the legacy storage-key fallback.
const OWNER_POLICIES: Readonly<Record<OperationalMediaOwnerType, OwnerPolicy>> = {
  machine: { moduleKey: "production" },
  client: { moduleKey: "clients" },
  fournisseur: { moduleKey: "fournisseurs" },
  outil: { moduleKey: "outillage" },
  outil_famille: { moduleKey: "outillage" },
  outil_geometrie: { moduleKey: "outillage" },
  outil_fabricant: { moduleKey: "outillage" },
  user: { authenticatedActiveUser: true },
};

function ownerPolicy(candidate: OperationalMediaAsset): OwnerPolicy | null {
  if (!(candidate.owner_type in OWNER_POLICIES)) return null;
  const policy = OWNER_POLICIES[candidate.owner_type as OperationalMediaOwnerType];
  return "authenticatedActiveUser" in policy
    ? candidate.module_key === "chat" ? policy : null
    : candidate.module_key === policy.moduleKey ? policy : null;
}

function profileAllowsModule(
  profile: Awaited<ReturnType<typeof resolveAccessProfile>>,
  policy: Exclude<OwnerPolicy, { authenticatedActiveUser: true }>,
): boolean {
  // Missing access-control infrastructure is fail-closed for private bytes.
  // Do not use the request AsyncLocalStorage grant: /operational-media is a
  // shared route and that grant says nothing about the bound owner module.
  return profile !== null && (
    profile.is_superadmin || profile.modules.some((entry) => entry.module_key === policy.moduleKey && entry.allowed)
  );
}

export async function authorizeOperationalMediaRead(params: { assetId: string; userId: number }) {
  if (!ASSET_ID.test(params.assetId)) throw new HttpError(404, "MEDIA_NOT_FOUND", "Média introuvable.");
  const assets = await findOperationalMediaAssets(params.assetId);
  // Non-disclosure: a caller must not be able to distinguish a missing asset
  // from one that belongs to another object/module.
  if (!assets.length) throw new HttpError(404, "MEDIA_NOT_FOUND", "Média introuvable.");
  let profile: Awaited<ReturnType<typeof resolveAccessProfile>> | undefined;
  let asset: OperationalMediaAsset | undefined;
  for (const candidate of assets) {
    const policy = ownerPolicy(candidate);
    if (!policy) continue;
    if (!("authenticatedActiveUser" in policy)) {
      profile ??= await resolveAccessProfile(params.userId);
      if (!profileAllowsModule(profile, policy)) continue;
    }
    // Each binding is checked independently. This avoids picking the first
    // module-visible binding when a physical blob was (legitimately or
    // accidentally) reused by a different owner.
    if (!await operationalMediaOwnerExists(candidate.owner_type as OperationalMediaOwnerType, candidate.owner_id)) continue;
    asset = candidate;
    break;
  }
  if (!asset) {
    throw new HttpError(404, "MEDIA_NOT_FOUND", "Média introuvable.");
  }
  if (asset.status === "REVOKED") throw new HttpError(410, "MEDIA_REVOKED", "Ce média n'est plus disponible.");
  if (asset.status === "QUARANTINED") throw new HttpError(423, "MEDIA_QUARANTINED", "Ce média est en quarantaine.");
  if (asset.status === "LEGACY_UNVERIFIED") throw new HttpError(423, "MEDIA_LEGACY_UNVERIFIED", "Ce média historique doit être vérifié avant consultation.");
  const storage = await checkOperationalMediaStorage();
  if (!storage.readable) {
    throw new HttpError(503, "MEDIA_STORAGE_UNAVAILABLE", "Le stockage des médias est temporairement indisponible.");
  }
  const root = getImagesRootPath();
  const candidate = path.resolve(root, asset.storage_key);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new HttpError(404, "MEDIA_NOT_FOUND", "Média introuvable.");
  // ACTIVE rows can only be created after byte-signature detection and a
  // clean scan. The secure sender re-hashes the opened inode before streaming;
  // never re-introduce extension-derived MIME trust here.
  if (!asset.mime_type || !asset.sha256 || !ALLOWED_MIME_TYPES.has(asset.mime_type)) throw new HttpError(415, "MEDIA_TYPE_NOT_ALLOWED", "Le type du média n'est pas autorisé.");
  return { asset, filePath: candidate, allowedRoots: [root], mimeType: asset.mime_type, expectedSha256: asset.sha256 };
}
