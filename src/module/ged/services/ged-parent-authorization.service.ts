import { resolveAccessProfile } from "../../access-control/services/access-control.service";
import { HttpError } from "../../../utils/httpError";
import { repoInternalListDocumentParentLinks, repoInternalParentLinkExists } from "../repository/ged.repository";

type ParentIdentity = "text" | "integer" | "uuid";
type ParentPolicy = Readonly<{ moduleKey: string; canonicalType: string; identity: ParentIdentity }>;

// GED links are free-text for historical compatibility. Delivery is not: only
// these explicitly reviewed parent shapes can authorize private bytes. Each
// alias resolves to the exact canonical parent that is revalidated in SQL.
const PARENT_POLICIES: Readonly<Record<string, ParentPolicy>> = {
  CLIENT: { moduleKey: "clients", canonicalType: "CLIENT", identity: "text" },
  FOURNISSEUR: { moduleKey: "fournisseurs", canonicalType: "FOURNISSEUR", identity: "uuid" },
  DEVIS: { moduleKey: "devis", canonicalType: "DEVIS", identity: "integer" },
  FACTURE: { moduleKey: "facturation", canonicalType: "FACTURE", identity: "integer" },
  AVOIR: { moduleKey: "facturation", canonicalType: "AVOIR", identity: "integer" },
  BON_LIVRAISON: { moduleKey: "livraisons", canonicalType: "BON_LIVRAISON", identity: "uuid" },
  LIVRAISON: { moduleKey: "livraisons", canonicalType: "BON_LIVRAISON", identity: "uuid" },
  COMMANDE_CLIENT: { moduleKey: "commandes-clients", canonicalType: "COMMANDE_CLIENT", identity: "integer" },
  "COMMANDE-CLIENT": { moduleKey: "commandes-clients", canonicalType: "COMMANDE_CLIENT", identity: "integer" },
  COMMANDE_FOURNISSEUR: { moduleKey: "commandes-fournisseurs", canonicalType: "COMMANDE_FOURNISSEUR", identity: "uuid" },
  "COMMANDE-FOURNISSEUR": { moduleKey: "commandes-fournisseurs", canonicalType: "COMMANDE_FOURNISSEUR", identity: "uuid" },
  AFFAIRE: { moduleKey: "affaires", canonicalType: "AFFAIRE", identity: "integer" },
  ORDRE_FABRICATION: { moduleKey: "production", canonicalType: "ORDRE_FABRICATION", identity: "integer" },
  "ORDRE-FABRICATION": { moduleKey: "production", canonicalType: "ORDRE_FABRICATION", identity: "integer" },
  OF: { moduleKey: "production", canonicalType: "ORDRE_FABRICATION", identity: "integer" },
  PIECE_TECHNIQUE: { moduleKey: "pieces-techniques", canonicalType: "PIECE_TECHNIQUE", identity: "uuid" },
  "PIECE-TECHNIQUE": { moduleKey: "pieces-techniques", canonicalType: "PIECE_TECHNIQUE", identity: "uuid" },
  PIECE_TECHNIQUE_VERSION: { moduleKey: "pieces-techniques", canonicalType: "PIECE_TECHNIQUE_VERSION", identity: "uuid" },
  STOCK_ARTICLE: { moduleKey: "stock", canonicalType: "STOCK_ARTICLE", identity: "integer" },
  "STOCK-ARTICLE": { moduleKey: "stock", canonicalType: "STOCK_ARTICLE", identity: "integer" },
  OUTIL: { moduleKey: "outillage", canonicalType: "OUTIL", identity: "integer" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER = /^\d+$/;

function opaqueNotFound(): never {
  // Identical for absent, unlinked, ambiguous, stale and foreign documents.
  throw new HttpError(404, "GED_VERSION_NOT_FOUND", "Version introuvable.");
}

function policyFor(entityType: string): ParentPolicy | null {
  return PARENT_POLICIES[entityType.trim().toUpperCase()] ?? null;
}

function canonicalParentId(value: string, identity: ParentIdentity): string | null {
  const id = value.trim();
  if (!id) return null;
  if (identity === "text") return id;
  if (identity === "uuid") return UUID.test(id) ? id : null;
  // PostgreSQL integer casts otherwise turn a malformed historical link into
  // a visible 500. The parent-link boundary must treat that record exactly
  // like an unknown or stale parent, before asking the repository anything.
  return INTEGER.test(id) ? id : null;
}

/**
 * Enforces one unambiguous live business parent and that parent's module ACL.
 * This is intentionally a shared service boundary rather than controller
 * convention: future GED transports must call it before resolving storage.
 */
export async function assertGedVersionParentReadable(actorUserId: number, documentId: string): Promise<{ moduleKey: string; entityType: string; entityId: string }> {
  const links = await repoInternalListDocumentParentLinks(documentId);
  if (links.length !== 1) opaqueNotFound();
  const link = links[0];
  const policy = policyFor(link.entity_type);
  const entityId = policy ? canonicalParentId(link.entity_id, policy.identity) : null;
  if (!policy || !entityId) opaqueNotFound();
  if (!await repoInternalParentLinkExists(policy.canonicalType, entityId)) opaqueNotFound();

  const profile = await resolveAccessProfile(actorUserId);
  if (!profile || !(profile.is_superadmin || profile.modules.some((entry) => entry.module_key === policy.moduleKey && entry.allowed))) {
    opaqueNotFound();
  }
  return { moduleKey: policy.moduleKey, entityType: policy.canonicalType, entityId };
}
