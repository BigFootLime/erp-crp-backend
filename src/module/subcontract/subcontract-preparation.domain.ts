import type { PurchasePreparation } from '../production/domain/purchase-preparation';
import { purchaseScopeKey } from '../production/domain/purchase-preparation';
import type { SubcontractSelection } from './subcontract-procurement.validators';
import { isSubcontractPieceUnit } from './subcontract-procurement.domain';

export type ServicePreparation = PurchasePreparation & {
    service: { selection: SubcontractSelection; forecastQuantity: number; realQuantity: number | null; existingQuantity: number };
};
export type ServicePreparationSource = {
    of: { id: number; quantity: number; hash: string | null; technicalVersion: string | null; ofRevisionId: string | null };
    hasDirectMaterial: boolean;
    purchases: Array<{ id: string; article_id: string | null; designation?: string | null; nom?: string | null; gamme_operation_id?: string | null }>;
    operations: Array<{ id: string; sourceId: string | null; label: string; returnDue: string | null }>;
    origins: Array<{ id: string; label: string }>;
    offers: Array<{ id: string; articleId: string; supplierId: string; price: number | null; unit: string; delay: number | null }>;
    drafts: Array<{ operationId: string; quantity: number; orderId: string; code: string }>;
    predecessorState: Array<{ operationId: string; predecessors: Array<{ status: string; good: number }> }>;
};

/** Forecasts are never real quantities or a fabricated allocation between MP roots. */
export function servicePurchasePreparations(source: ServicePreparationSource, selections: SubcontractSelection[]): ServicePreparation[] {
    return source.purchases.map(purchase => {
        const saved = selections.find(selection => selection.purchaseId === purchase.id);
        const eligible = source.operations.filter(op => !purchase.gamme_operation_id || op.sourceId === purchase.gamme_operation_id);
        const operation = saved?.operationId ? eligible.find(op => op.id === saved.operationId) : eligible.length === 1 ? eligible[0] : undefined;
        const offer = saved?.catalogueId ? source.offers.find(candidate => candidate.id === saved.catalogueId && candidate.articleId === purchase.article_id) : undefined;
        const selection: SubcontractSelection = { purchaseId: purchase.id, operationId: saved?.operationId ?? operation?.id ?? null,
            catalogueId: saved?.catalogueId ?? null, destinationId: saved?.destinationId ?? null, due: saved?.due ?? operation?.returnDue ?? null };
        const predecessors = source.predecessorState.find(state => state.operationId === operation?.id)?.predecessors ?? [];
        const realQuantity = predecessors.length && predecessors.every(predecessor => predecessor.status === 'DONE')
            ? Math.max(0, Math.min(source.of.quantity, ...predecessors.map(predecessor => predecessor.good))) : null;
        const existing = operation ? source.drafts.filter(draft => draft.operationId === operation.id) : [];
        const existingQuantity = existing.reduce((total, draft) => total + draft.quantity, 0);
        const missing = realQuantity === null ? null : Math.max(0, realQuantity - existingQuantity);
        const actions: string[] = [];
        if (!source.of.hash) actions.push('Valider le dossier technique avant de créer les lignes fournisseur.');
        if (!purchase.article_id) actions.push('Relier cette prestation à son article fournisseur.');
        if (!operation) actions.push('Choisir ou relier la phase de sous-traitance de cette prestation.');
        if (!offer) actions.push(saved?.catalogueId ? 'Actualiser les conditions fournisseur devenues indisponibles.' : 'Choisir le fournisseur et ses conditions d’achat.');
        if (offer?.price === null) actions.push('Confirmer le tarif avant validation de la commande.');
        if (offer && !isSubcontractPieceUnit(offer.unit))
            actions.push('Choisir des conditions en pièces pour la répartition par lot matière.');
        if (!selection.due && offer?.delay == null) actions.push('Confirmer une date de retour ou un délai fournisseur.');
        if (source.hasDirectMaterial && !source.origins.length) actions.push('Réserver les origines matière ; le choix du fournisseur peut être enregistré dès maintenant.');
        if (realQuantity === null) actions.push('Confirmer les quantités réellement conformes après clôture des opérations précédentes.');
        if (source.origins.length > 1) actions.push('Renseigner la répartition réelle des pièces par origine matière ; aucune répartition automatique.');
        if (existing.length) actions.push(`Examiner les lignes existantes (${[...new Set(existing.map(draft => draft.code))].join(', ')}) avant un nouvel achat.`);
        return {
            scopeKey: purchaseScopeKey({ ofId: source.of.id, technicalVersion: source.of.technicalVersion, technicalHash: source.of.hash,
                ofRevisionId: source.of.ofRevisionId }, 'PRESTATION', `${purchase.id}:${operation?.id ?? 'unassigned'}`),
            kind: 'PRESTATION', mode: 'OF', ofId: source.of.id, sourceRef: purchase.id, needId: null,
            technicalVersion: source.of.technicalVersion, technicalHash: source.of.hash, ofRevisionId: source.of.ofRevisionId,
            articleId: purchase.article_id, designation: purchase.designation ?? purchase.nom ?? operation?.label ?? 'Prestation à définir',
            unit: 'U', required: source.of.quantity, missing, ordered: missing, purchaseUnit: 'U', supplierId: offer?.supplierId ?? null,
            destinationId: selection.destinationId, status: actions.length ? 'A_COMPLETER' : missing === 0 ? 'COUVERTE' : 'A_COMMANDER', actions,
            operation: operation?.label ?? null, due: selection.due, requirements: null,
            futurePurchases: [...new Map(existing.map(draft => [draft.orderId, { id: draft.orderId, code: draft.code,
                available: existing.filter(line => line.orderId === draft.orderId).reduce((total, line) => total + line.quantity, 0) }])).values()],
            service: { selection, forecastQuantity: source.of.quantity, realQuantity, existingQuantity },
        };
    });
}
