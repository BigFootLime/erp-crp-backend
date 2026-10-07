import type { DebitRule, MaterialRequirements } from './of-material';
export type MaterialArticleDefaults = {
    id: string;
    code: string;
    unite: string | null;
    client_proprietaire_id: string | null;
    grade: string | null;
    condition: string | null;
    sub_condition: string | null;
    longueur_mm: number | null;
    longueur_brut_mm: number | null;
    diametre_mm: number | null;
    largeur_mm: number | null;
    epaisseur_mm: number | null;
};
export type MaterialPurchaseDefaults = {
    gamme_operation_id?: string | null;
    phase?: number | null;
    quantite: number;
    unite_prix: string | null;
    longueur_mm?: number | null;
    quantite_brut_mm?: number | null;
};
export type MaterialConfigurationProposal = {
    operationId: string | null;
    requirements: MaterialRequirements;
    debitRule: DebitRule | null;
    supplyMode: 'PURCHASE' | 'CUSTOMER';
    purchaseLengthMm: number | null;
    sources: string[];
};
const positive = (value: number | null | undefined): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
/** Suggestions do not constitute reviewed technical or quality evidence. */
export function proposeMaterialConfiguration(purchase: MaterialPurchaseDefaults, article: MaterialArticleDefaults | undefined, operations: Array<{
    id: string;
    phase: number;
    sourceId: string | null;
}>, clientId: string | null): MaterialConfigurationProposal {
    const attached = purchase.gamme_operation_id ? operations.filter(o => o.sourceId === purchase.gamme_operation_id) : [];
    const phase = typeof purchase.phase === 'number' ? operations.filter(o => o.phase === purchase.phase) : [];
    const operation = attached.length === 1 ? attached[0] : phase.length === 1 ? phase[0] : operations.length === 1 ? operations[0] : undefined;
    const stockUnit = article?.unite?.trim() ?? '';
    const normalized = stockUnit.toUpperCase();
    const lengthUnit = normalized === 'MM' || normalized === 'M';
    const dimensions: Record<string, number> = {};
    const ptLength = positive(purchase.longueur_mm) ?? positive(purchase.quantite_brut_mm);
    const length = ptLength ?? (lengthUnit ? null : positive(article?.longueur_brut_mm) ?? positive(article?.longueur_mm));
    for (const [key, value] of Object.entries({ diametre_mm: article?.diametre_mm, longueur_mm: length, largeur_mm: article?.largeur_mm, epaisseur_mm: article?.epaisseur_mm })) {
        const dimension = positive(value);
        if (dimension !== null)
            dimensions[key] = dimension;
    }
    const raw = positive(purchase.quantite);
    const sameUnit = purchase.unite_prix?.trim().toUpperCase() === normalized;
    // Never use a 3 m stock bar as the per-piece consumption of a 110 mm blank.
    const unitsPerBlank = lengthUnit && ptLength !== null ? ptLength / (normalized === 'M' ? 1000 : 1) : sameUnit ? raw : null;
    const debitRule: DebitRule | null = stockUnit && unitsPerBlank !== null ? {
        form: lengthUnit ? 'BAR' : ['M2', 'M²', 'MM2', 'MM²'].includes(normalized) ? 'SHEET' : 'UNIT', stockUnit, unitsPerBlank, kerfPerBlank: 0, yieldValidated: false,
    } : null;
    const owner = article?.client_proprietaire_id === clientId ? clientId : null;
    const sources: string[] = [];
    if (article)
        sources.push(`Article ${article.code}`);
    if (ptLength !== null || sameUnit && raw !== null)
        sources.push('Nomenclature matière de la PT');
    if (operation)
        sources.push('Opération rattachée');
    return { operationId: operation?.id ?? null, requirements: { grade: article?.grade ?? null, condition: article?.condition ?? null,
            ownerClientId: owner, dimensions, certificates: [], manualChecks: [] }, debitRule, supplyMode: owner ? 'CUSTOMER' : 'PURCHASE',
        purchaseLengthMm: lengthUnit ? positive(article?.longueur_mm) : null, sources };
}
