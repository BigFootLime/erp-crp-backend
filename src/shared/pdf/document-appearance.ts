/** Print-only appearance: no font, size, spacing or pagination tokens belong here. */
export type DocumentCategory = "production" | "commerce" | "qualite" | "stock" | "outillage" | "systeme";

export const DOCUMENT_CATEGORY_ACCENTS = {
  production: "#0f766e", commerce: "#2563eb", qualite: "#b45309",
  stock: "#6d28d9", outillage: "#c1121f", systeme: "#4b5560",
} as const;

export const LEGACY_DOCUMENT_COLORS = {
  brand: "#B90101", ink: "#101418", graphite: "#3D444C", steel: "#6E7681",
  hairline: "#D5DAE0", hairlineSoft: "#E7EAEE", wash: "#F5F6F8", paper: "#FFFFFF",
  heading: "#3D444C", danger: "#B90101",
} as const;

export type DocumentColors = { readonly [K in keyof typeof LEGACY_DOCUMENT_COLORS]: string } & { readonly cornerRadius?: number };

const headings: Record<DocumentCategory, string> = {
  production: "#123f3b", commerce: "#102b46", qualite: "#49321d",
  stock: "#302544", outillage: "#49252c", systeme: "#33414b",
};

/** Omitted category intentionally preserves deterministic historic OF editions. */
export function documentColors(category?: DocumentCategory): DocumentColors {
  if (!category) return LEGACY_DOCUMENT_COLORS;
  return {
    brand: DOCUMENT_CATEGORY_ACCENTS[category], ink: "#152e3d", graphite: "#314b59",
    steel: "#435d73", hairline: "#b9c8d3", hairlineSoft: "#dce5eb",
    wash: "#eff3f6", paper: "#FFFFFF", heading: headings[category], danger: "#B90101", cornerRadius: 6,
  };
}

export function creationDocumentCategory(entityType: string): DocumentCategory {
  if (["ordre-fabrication", "of", "piece-technique", "piece-technique-version", "production_of"].includes(entityType)) return "production";
  if (["stock-article", "stock_article"].includes(entityType)) return "stock";
  if (["client", "fournisseur", "commande-client", "commande-fournisseur", "devis", "affaire", "bon-livraison", "livraison", "facture", "avoir", "proforma"].includes(entityType)) return "commerce";
  return "systeme";
}

/** Versioned presentation only; pending historical archives keep their original palette. */
export const MODULE_APPEARANCE_SUFFIX = "+style-20261019";
export function hasModuleAppearance(renderVersion: string): boolean {
  return typeof renderVersion === "string" && renderVersion.endsWith(MODULE_APPEARANCE_SUFFIX);
}
export function baseDocumentRenderVersion(renderVersion: string): string {
  return hasModuleAppearance(renderVersion) ? renderVersion.slice(0, -MODULE_APPEARANCE_SUFFIX.length) : renderVersion;
}
export function archiveDocumentCategory(renderVersion: string, category: DocumentCategory): DocumentCategory | undefined {
  return hasModuleAppearance(renderVersion) ? category : undefined;
}
