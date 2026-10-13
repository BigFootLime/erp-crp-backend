import type { OfDocumentDecoupe, OfDocumentOperationExecution } from "./of-document";

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const documentUuid = (value: unknown): string | null => {
  const candidate = text(value);
  return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
};
const modern = (value: JsonRecord) => documentUuid(object(value.version).id) !== null && Object.keys(object(value.piece)).length > 0;

export type OfDocumentTechnicalSource = {
  kind: "REVISION_SNAPSHOT" | "ACTIVE_TECHNICAL_SNAPSHOT" | "LEGACY_REVISION";
  hash: string;
  technicalVersionId: string | null;
  snapshot: JsonRecord;
};

/** A seed revision is not a copy of the technical dossier. Only the active revision may borrow its own frozen OF dossier. */
export function resolveOfDocumentTechnicalSource(input: {
  revisionStatus: string; revisionHash: string; revisionSnapshot: unknown;
  rootHash: string | null; rootSnapshot: unknown;
}): OfDocumentTechnicalSource {
  const revision = object(input.revisionSnapshot), root = object(input.rootSnapshot);
  if (modern(revision)) return { kind: "REVISION_SNAPSHOT", hash: input.revisionHash, technicalVersionId: text(object(revision.version).id), snapshot: revision };
  if (input.revisionStatus === "ACTIVE" && input.rootHash && modern(root)) return {
    kind: "ACTIVE_TECHNICAL_SNAPSHOT", hash: input.rootHash, technicalVersionId: text(object(root.version).id), snapshot: root,
  };
  return { kind: "LEGACY_REVISION", hash: input.revisionHash, technicalVersionId: null, snapshot: revision };
}

export type WorkshopDocumentMaterial = {
  needId: string | null; reference: string | null; designation: string; phase: number | null;
  requiredQuantity: number | null; unit: string | null; grade: string | null; condition: string | null;
  dimensions: Record<string, number>; certificates: string[]; manualChecks: string[];
  debitPerBlank: number | null; form: string | null; confirmed: boolean;
};
export type WorkshopDocumentMaterialDebit = {
  phase: number; lot: string; bar: string | null; unit: string | null;
  actual: number; cut: number; discarded: number; remaining: number | null; closed: boolean;
  quantityGood: number | null; quantityScrap: number | null; recordedAt: string;
  quantityKind: string;
};
export type WorkshopDocumentPurchase = { type: string; designation: string; phase: number | null; quantityPerPiece: number | null; unit: string | null; reference?: string | null };
export type WorkshopDocumentComponent = {
  id: string; repere: string | null; reference: string | null; indice: string | null; designation: string | null;
  quantityPerParent: number | null; requiredQuantity: number | null; unit: string | null;
};
export type WorkshopDocumentTechnicalEvidence = {
  source: { kind: OfDocumentTechnicalSource["kind"]; hash: string; technicalVersionId: string | null };
  materials: WorkshopDocumentMaterial[]; debits: WorkshopDocumentMaterialDebit[];
  purchases: WorkshopDocumentPurchase[]; documents: string[]; correctionCount: number;
  materialNotRequired: boolean;
  nomenclature?: WorkshopDocumentComponent[];
};

export function ofDocumentTechnicalIdentity(source: OfDocumentTechnicalSource) {
  const piece = object(source.snapshot.piece), version = object(source.snapshot.version), gamme = object(source.snapshot.gamme);
  return {
    pieceReference: text(version.plan_reference) ?? text(piece.code) ?? text(source.snapshot.pieceReference),
    pieceDesignation: text(piece.designation) ?? text(source.snapshot.pieceDesignation),
    pieceIndice: text(version.indice_externe) ?? text(version.indice) ?? text(source.snapshot.pieceIndice),
    gammeCode: text(gamme.code) ?? text(gamme.nom) ?? text(source.snapshot.gammeCode),
    gammeVersion: numeric(version.version_interne)?.toString() ?? text(version.version_interne) ?? text(source.snapshot.gammeVersion),
  };
}

export function ofDocumentFrozenMaterialExemption(source: OfDocumentTechnicalSource): boolean {
  const preparation = object(source.snapshot.preparation_evidence), decisions = object(source.snapshot.preparation_decisions);
  return source.kind !== "LEGACY_REVISION"
    && (text(object(source.snapshot.version).manufacturing_mode) ?? text(object(preparation.version).manufacturing_mode)) === "ASSEMBLY"
    && object(decisions.material).mode === "NOT_REQUIRED"
    && (text(object(decisions.material).reason)?.length ?? 0) >= 3
    && Array.isArray(preparation.purchases)
    && !list(preparation.purchases).some(value => object(value).type_achat === "MATIERE");
}

export function ofDocumentFrozenPurchases(source: OfDocumentTechnicalSource): JsonRecord[] {
  const prepared = object(source.snapshot.preparation_evidence).purchases;
  return list(Array.isArray(prepared) ? prepared : source.snapshot.achats).map(object);
}

export function ofDocumentFrozenNomenclature(source: OfDocumentTechnicalSource): JsonRecord[] {
  return list(source.snapshot.nomenclature).map(object);
}

/** Keep the frozen per-parent quantity, even if references from an old dossier are missing. */
export function ofDocumentComponent(row: JsonRecord, launched: number): WorkshopDocumentComponent {
  const perParent = numeric(row.quantite);
  return { id: String(row.id ?? ""), repere: text(row.repere), reference: text(row.reference), indice: text(row.indice),
    designation: text(row.designation), quantityPerParent: perParent,
    requiredQuantity: perParent !== null && Number.isFinite(launched) && launched >= 0 ? Math.round(perParent * launched * 1000) / 1000 : null,
    unit: text(row.unit) ?? (documentUuid(row.child_piece_technique_id) ? "pièce" : null) };
}

export function ofDocumentFrozenDocuments(source: OfDocumentTechnicalSource): string[] {
  const roles: Record<string, string> = { PLAN_CLIENT: "Plan client", PLAN_CONTROLE: "Plan de contrôle", FICHE_REGLAGE: "Fiche de réglage", PROGRAMME_CN: "Programme CN" };
  const identity = ofDocumentTechnicalIdentity(source);
  return list(source.snapshot.documents).flatMap(value => {
    const document = object(value), role = text(document.role);
    if (!role) return [];
    const reference = text(document.title) ?? text(document.name) ?? (role === "PLAN_CLIENT" ? identity.pieceReference : null);
    return [[roles[role] ?? role, reference, role === "PLAN_CLIENT" && identity.pieceIndice ? `indice ${identity.pieceIndice}` : null].filter(Boolean).join(" - ")];
  });
}

/** Invalid counters are a source error; neither signatures nor plausible substitute numbers are generated. */
export function ofDocumentExecution(row: { status: string; good: unknown; scrap: unknown; pending: unknown; rework: unknown }): OfDocumentOperationExecution {
  const count = (value: unknown): number => {
    const result = value === null || value === undefined ? 0 : Number(value);
    if (!Number.isFinite(result) || result < 0) throw new Error("Invalid OF document execution counter");
    return result;
  };
  return { statut: row.status, bonnes: count(row.good), rebuts: count(row.scrap), attenteControle: count(row.pending), reprises: count(row.rework) };
}

/** A stock debit step is not necessarily the physical blank length: do not remove an implicit kerf or assume one piece per blank. */
export function ofDocumentModernDebit(materials: readonly WorkshopDocumentMaterial[]): Partial<OfDocumentDecoupe> {
  const material = materials[0];
  if (!material) return {};
  return {
    unite: material.unit,
    longueurTotaleMm: material.confirmed && material.unit?.toLowerCase() === "mm" ? material.requiredQuantity : null,
    methodeCalcul: material.confirmed && material.requiredQuantity !== null
      ? `Besoin matière validé : ${material.requiredQuantity} ${material.unit ?? "unité non renseignée"}.` : null,
  };
}
