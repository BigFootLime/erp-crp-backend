import { materialPropertiesFingerprint, purchaseQuantity, quantity, type MaterialRequirements } from './of-material';

export type PurchasePreparation = {
  scopeKey: string; kind: 'MATIERE' | 'CONSOMMABLE' | 'PRESTATION'; mode: 'OF' | 'GLOBAL_PACK';
  ofId: number | null; sourceRef: string | null; needId: string | null;
  technicalVersion: string | null; technicalHash: string | null; ofRevisionId: string | null;
  articleId: string | null; designation: string; unit: string | null;
  required: number; missing: number | null; ordered: number | null; purchaseUnit: string | null;
  supplierId: string | null; destinationId: string | null;
  status: 'A_COMPLETER' | 'A_COMMANDER' | 'COUVERTE'; actions: string[];
  operation: string | null; due: string | null; requirements: MaterialRequirements | null;
  futurePurchases: Array<{ id: string; code: string; available: number }>;
};
export type SavedPurchasePreparation = PurchasePreparation & { id: string | null; saved: boolean; updatedAt: string | null };

type Identity = { ofId: number; technicalVersion: string | null; technicalHash: string | null; ofRevisionId?: string | null };
export const purchaseScopeKey = (identity: Identity, kind: PurchasePreparation['kind'], sourceRef: string) =>
  materialPropertiesFingerprint({ ofId: identity.ofId, technicalVersion: identity.technicalVersion, technicalHash: identity.technicalHash,
    ofRevisionId: identity.ofRevisionId ?? null, kind, sourceRef });
export const sharedPurchaseScopeKey = (articleId: string) => materialPropertiesFingerprint({ kind: 'CONSOMMABLE', mode: 'GLOBAL_PACK', articleId });

type MaterialPreparationNeed = {
  key: string; id: string | null; articleId: string | null; designation: string; unit: string | null;
  supplyMode: 'PURCHASE' | 'CUSTOMER'; required: number; purchaseMissing: number; blockers: string[];
  supplierId: string | null; destinationId: string | null; price: number | null;
  operationId: string | null; operationLabel: string | null; requirements: MaterialRequirements;
  catalog?: { moq: number | null; lot_achat: number | null } | null;
  futureSupplies: Array<{ id: string; code: string; available: number; reasons: string[] }>;
};
export function materialPurchasePreparations(input: Identity & {
  needs: MaterialPreparationNeed[]; previousNeeds: unknown[]; operations: Array<{ id: string; start?: string | null }>;
}): PurchasePreparation[] {
  return input.needs.filter(need => need.supplyMode === 'PURCHASE').map(need => {
    const definition = [...need.blockers];
    if (input.previousNeeds.length) definition.push('Rapprocher les engagements de la version précédente.');
    const missing = definition.length ? null : quantity(need.purchaseMissing);
    const futurePurchases = need.futureSupplies.filter(p => !p.reasons.length && p.available > 0)
      .map(p => ({ id: p.id, code: p.code, available: p.available }));
    const actions = [...definition];
    if (missing !== 0) {
      if (!need.supplierId) actions.push('Choisir le fournisseur.');
      if (need.price === null) actions.push('Confirmer le tarif fournisseur avant validation de la commande.');
      if (futurePurchases.length) actions.push('Examiner les achats attendus disponibles avant de créer un nouvel achat.');
    }
    return {
      scopeKey: purchaseScopeKey(input, 'MATIERE', need.key), kind: 'MATIERE', mode: 'OF', ofId: input.ofId,
      sourceRef: need.key, needId: need.id, technicalVersion: input.technicalVersion, technicalHash: input.technicalHash,
      ofRevisionId: input.ofRevisionId ?? null, articleId: need.articleId, designation: need.designation, unit: need.unit,
      required: need.required, missing, ordered: missing === null ? null : purchaseQuantity(missing, need.catalog?.moq ?? null, need.catalog?.lot_achat ?? null).ordered,
      purchaseUnit: need.unit,
      supplierId: need.supplierId, destinationId: need.destinationId,
      status: missing === 0 ? 'COUVERTE' : actions.length ? 'A_COMPLETER' : 'A_COMMANDER', actions,
      operation: need.operationLabel, due: input.operations.find(op => op.id === need.operationId)?.start?.slice(0, 10) ?? null,
      requirements: need.requirements, futurePurchases,
    };
  });
}

type ConsumablePreparationNeed = {
  key: string; id: string | null; articleId: string | null; designation: string; unit: string | null;
  mode: 'UNIT' | 'GLOBAL_PACK' | 'NONE'; required: number; assigned: number; articlePack: number;
  purchase: { assigned: number; ordered: number }; blockers: string[];
  supplierId: string | null; destinationId: string | null; catalogue: { price: number | null; unit: string | null } | null;
  futureSupplies: Array<{ id: string; code: string; available: number; compatible: boolean }>;
  articleDesignation?:string|null;
};
export function consumablePurchasePreparations(input: Identity & {
  needs: ConsumablePreparationNeed[]; previousNeeds: unknown[];
}): PurchasePreparation[] {
  const shared = new Set<string>();
  return input.needs.flatMap(need => {
    // An unresolved OF definition cannot overwrite the shared article request.
    const global = need.mode === 'GLOBAL_PACK' && !!need.articleId && !need.blockers.length && !input.previousNeeds.length;
    if (global && shared.has(need.articleId!)) return [];
    if (global) shared.add(need.articleId!);
    const definition = [...need.blockers];
    if (input.previousNeeds.length) definition.push('Rapprocher les engagements de la version précédente.');
    const missing = definition.length ? null : quantity(global ? need.purchase.assigned : need.assigned);
    const futurePurchases = global ? [] : need.futureSupplies.filter(p => p.compatible && p.available > 0)
      .map(p => ({ id: p.id, code: p.code, available: p.available }));
    const actions = [...definition];
    if (missing !== 0) {
      if (global || !need.supplierId || !need.catalogue) actions.push('Choisir le fournisseur et ses conditions d’achat dans la fiche article.');
      if (global || need.catalogue?.price == null) actions.push('Confirmer le tarif fournisseur avant validation de la commande.');
      if (futurePurchases.length) actions.push('Examiner les achats attendus disponibles avant de créer un nouvel achat.');
    }
    return [{
      scopeKey: global ? sharedPurchaseScopeKey(need.articleId!) : purchaseScopeKey(input, 'CONSOMMABLE', need.key),
      kind: 'CONSOMMABLE', mode: global ? 'GLOBAL_PACK' : 'OF', ofId: global ? null : input.ofId,
      sourceRef: global ? null : need.key, needId: global ? null : need.id,
      technicalVersion: global ? null : input.technicalVersion, technicalHash: global ? null : input.technicalHash,
      ofRevisionId: global ? null : input.ofRevisionId ?? null, articleId: need.articleId,
      designation: global ? need.articleDesignation ?? need.designation : need.designation, unit: need.unit, required: global ? need.articlePack : need.required,
      // Shared demand uses stock units and the article pack; vendor conversion is chosen at confirmation.
      missing, ordered: missing === null ? null : global ? missing : need.purchase.ordered, purchaseUnit: global ? need.unit : need.catalogue?.unit ?? need.unit,
      supplierId: global ? null : need.supplierId, destinationId: global ? null : need.destinationId,
      status: missing === 0 ? 'COUVERTE' : actions.length ? 'A_COMPLETER' : 'A_COMMANDER', actions,
      operation: global ? 'Réapprovisionnement partagé' : 'Consommable OF', due: null, requirements: null, futurePurchases,
    } satisfies PurchasePreparation];
  });
}
