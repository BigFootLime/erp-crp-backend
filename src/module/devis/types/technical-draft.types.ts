export type TechnicalDraftSource = "DEVIS" | "COMMANDE" | "CERP" | "MANUAL";

export type TechnicalDraftValue<T = unknown> = {
  value?: T;
  source: TechnicalDraftSource;
  source_ref?: string | null;
  needs_matching?: boolean;
};

export type TechnicalDraftSection = {
  version: 1;
  values: Record<string, TechnicalDraftValue>;
};

/**
 * Stable boundary between a quote's preparatory data and the controlled PT
 * editor. Unknown legacy keys remain in `unmapped`: they are visible proposals,
 * never silently promoted into official reference data.
 */
export type TechnicalDraftDTO = {
  schema_version: 1 | 2;
  source: "DEVIS";
  source_devis_id: number;
  source_dossier_id?: string | null;
  completion_percent: number;
  sections: {
    identity: TechnicalDraftSection;
    material: TechnicalDraftSection;
    bom: TechnicalDraftSection;
    routing: TechnicalDraftSection;
    operations: TechnicalDraftSection;
    treatments: TechnicalDraftSection;
    quality: TechnicalDraftSection;
    documents: TechnicalDraftSection;
    manufacturing?: TechnicalDraftSection;
  };
  unmapped: Record<string, TechnicalDraftValue>;
};
