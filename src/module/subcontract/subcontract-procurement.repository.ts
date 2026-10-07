import type { PoolClient } from 'pg';
import pool from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { coverageFingerprint } from '../production/domain/of-material';
import { assertMaterialOriginLimit } from '../production/domain/of-material-policy';
import { readMaterialOriginPolicyTx } from '../production/repository/of-material-policy.repository';
import { consumableCommand } from '../production/repository/consumable-command.repository';
import type { AuditContext } from '../production/repository/production.repository';
import { createMaterialDraftsTx } from '../commande-fournisseur/repository/commande-fournisseur.repository';
import { readSubcontractPredecessorsTx } from '../commande-fournisseur/repository/subcontract-purchase.repository';
import { subcontractSelection, type SubcontractProcurementCommand, type SubcontractDemandCommand, type SubcontractSelection } from './subcontract-procurement.validators';
import { assertSubcontractPieceUnit } from './subcontract-procurement.domain';
import { servicePurchasePreparations, type ServicePreparation } from './subcontract-preparation.domain';
import { readPurchasePreparationsTx, savePurchasePreparationsTx } from '../production/repository/purchase-preparation.repository';
type Db = Pick<PoolClient, 'query'>;
type Purchase = {
    id: string;
    article_id: string | null;
    type_achat: string;
    designation?: string;
    nom?: string;
    gamme_operation_id?: string | null;
};
export async function readSubcontractProcurementTx(tx: Db, ofId: number, selectionOverride?: SubcontractSelection) {
    const of = (await tx.query<{
        id: number;
        number: string;
        quantity: number;
        status: string;
        hash: string | null;
        technicalVersion: string | null;
        ofRevisionId: string | null;
        purchases: Purchase[];
    }>(`
    SELECT o.id::int,o.numero AS number,o.quantite_lancee::float8 AS quantity,o.statut::text AS status,o.technical_snapshot_sha256 AS hash,
      o.piece_technique_version_id::text AS "technicalVersion",r.id::text AS "ofRevisionId",
      COALESCE(o.technical_snapshot->'preparation_evidence'->'purchases',
        (SELECT jsonb_agg(to_jsonb(p)) FROM public.pieces_techniques_achats p WHERE p.piece_technique_id=o.piece_technique_id AND p.piece_technique_version_id=o.piece_technique_version_id),'[]'::jsonb) AS purchases
    FROM public.ordres_fabrication o LEFT JOIN public.of_revisions r ON r.of_id=o.id AND r.statut='ACTIVE' WHERE o.id=$1`, [ofId])).rows[0];
    if (!of)
        throw new HttpError(404, 'OF_NOT_FOUND', 'OF introuvable.');
    const purchases = of.purchases.filter(p => ['SOUS_TRAITANCE', 'TRAITEMENT'].includes(p.type_achat));
    const operations = (await tx.query<{
        id: string;
        sourceId: string | null;
        label: string;
        status: string;
        phase: number;
        returnDue: string | null;
    }>(`
    SELECT op.id::text,op.source_piece_operation_id::text AS "sourceId",op.designation AS label,op.status::text,op.phase,
      (SELECT (max(e.end_ts) AT TIME ZONE 'Europe/Paris')::date::text FROM public.planning_events e
       WHERE e.of_operation_id=op.id AND e.archived_at IS NULL AND e.status<>'CANCELLED') AS "returnDue"
    FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id
    LEFT JOIN public.pieces_techniques_operations source ON source.id=op.source_piece_operation_id
    LEFT JOIN LATERAL(SELECT value FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]')) WHERE value->>'phase'=op.phase::text LIMIT 1) frozen ON true
    WHERE op.of_id=$1 AND op.status::text<>'CANCELLED' AND COALESCE(frozen.value->>'type_operation',source.type_operation)='SOUS_TRAITANCE'
      AND(op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE')) ORDER BY op.phase,op.id`, [ofId])).rows;
    const policy = await readMaterialOriginPolicyTx(tx, [ofId]);
    assertMaterialOriginLimit(policy, []);
    const origins = (await tx.query<{
        id: string;
        label: string;
    }>('SELECT id::text,lot_code AS label FROM public.lots WHERE id=ANY($1::uuid[]) ORDER BY lot_code,id', [policy.usedOrigins])).rows;
    const offers = (await tx.query<{
        id: string;
        articleId: string;
        supplierId: string;
        supplierName: string;
        unit: string;
        price: number | null;
        currency: string;
        delay: number | null;
        reference: string | null;
        forfait: number | null;
        minimumInvoice: number | null;
        minimumQuantity: number | null;
    }>(`
    SELECT c.id::text,c.article_id::text AS "articleId",c.fournisseur_id::text AS "supplierId",COALESCE(f.nom,f.raison_sociale) AS "supplierName",
      c.unite AS unit,c.prix_unitaire::float8 AS price,c.devise AS currency,c.delai_jours AS delay,c.reference_fournisseur AS reference,
      c.forfait_ht::float8 AS forfait,c.minimum_facturation_ht::float8 AS "minimumInvoice",c.moq::float8 AS "minimumQuantity"
    FROM public.fournisseur_catalogue c JOIN public.fournisseurs f ON f.id=c.fournisseur_id WHERE c.article_id=ANY($1::uuid[]) AND c.actif AND f.actif IS NOT FALSE
      AND(c.valid_from IS NULL OR c.valid_from<=current_date) AND(c.valid_to IS NULL OR c.valid_to>=current_date) ORDER BY 4,c.id`, [purchases.flatMap(p => p.article_id ? [p.article_id] : [])])).rows;
    const drafts = (await tx.query<{
        lineId: string;
        purchaseId: string | null;
        operationId: string;
        originId: string | null;
        quantity: number;
        orderId: string;
        code: string;
        status: string;
    }>(`
    SELECT p.line_id::text AS "lineId",p.preparation_snapshot->'purchase'->>'id' AS "purchaseId",
      p.operation_id::text AS "operationId",p.material_origin_id::text AS "originId",l.quantite::float8 AS quantity,
      c.id::text AS "orderId",c.code,c.statut::text AS status FROM public.subcontract_purchase_origins p
    JOIN public.commande_fournisseur_ligne l ON l.id=p.line_id JOIN public.commande_fournisseur c ON c.id=l.commande_id
    WHERE p.of_id=$1 AND l.statut_ligne='ACTIVE' AND c.statut<>'ANNULEE' ORDER BY p.created_at,p.line_id`, [ofId])).rows;
    const destinations = (await tx.query<{
        id: string;
        name: string;
    }>('SELECT id::text,COALESCE(code,code_magasin) AS name FROM public.magasins ORDER BY 2')).rows;
    const predecessorState = await Promise.all(operations.map(async (op) => ({ operationId: op.id, predecessors: await readSubcontractPredecessorsTx(tx, op.id) })));
    const coveredByOfId = (await tx.query<{ id: number }>(`SELECT c.producer_of_id::bigint::int AS id
      FROM public.production_consolidation_allocations a JOIN public.production_consolidations c ON c.id=a.consolidation_id
      WHERE a.source_of_id=$1 AND a.state='ACTIVE' AND c.state='ACTIVE'`, [ofId])).rows[0]?.id ?? null;
    const savedRows = (await tx.query<{ selection: unknown }>(`SELECT snapshot->'service'->'selection' AS selection
      FROM public.production_purchase_preparations WHERE of_id=$1 AND kind='PRESTATION' AND status<>'PERIMEE'
      AND technical_version_id IS NOT DISTINCT FROM $2::uuid AND technical_hash IS NOT DISTINCT FROM $3::text
      AND of_revision_id IS NOT DISTINCT FROM $4::uuid ORDER BY updated_at DESC,id`, [ofId, of.technicalVersion, of.hash, of.ofRevisionId])).rows;
    const selections = savedRows.flatMap(row => { const parsed = subcontractSelection.safeParse(row.selection); return parsed.success ? [parsed.data] : []; });
    if (selectionOverride) {
        const purchase = purchases.find(p => p.id === selectionOverride.purchaseId);
        if (!purchase || selectionOverride.operationId && !operations.some(op => op.id === selectionOverride.operationId && (!purchase.gamme_operation_id || purchase.gamme_operation_id === op.sourceId))
            || selectionOverride.catalogueId && !offers.some(offer => offer.id === selectionOverride.catalogueId && offer.articleId === purchase.article_id))
            throw new HttpError(422, 'SUBCONTRACT_SELECTION_INVALID', 'Choisissez la prestation, sa phase et des conditions fournisseur actuellement applicables.');
        if (selectionOverride.destinationId && !destinations.some(destination => destination.id === selectionOverride.destinationId))
            throw new HttpError(422, 'SUBCONTRACT_DESTINATION_INVALID', 'Choisissez un magasin existant.');
        selections.unshift(selectionOverride);
    }
    const result = { of: { ...of, purchases: undefined }, coveredByOfId, maximumOrigins: policy.maximumLots,
        hasDirectMaterial: of.purchases.some(p => p.type_achat === 'MATIERE'), purchases, operations, origins, offers, drafts, destinations, predecessorState };
    const proposals = servicePurchasePreparations(result, selections);
    const prepared = await readPurchasePreparationsTx(tx, proposals, ofId, 'PRESTATION');
    // Ledger timestamps are excluded: saving the same projection must not invalidate itself.
    return { ...result, version: coverageFingerprint({ ...result, proposals }),
        purchasePreparations: prepared.items as Array<ServicePreparation & { id: string | null; saved: boolean; updatedAt: string | null }>, purchasePreparationsRequireSync: prepared.requiresSync };
}
export async function readSubcontractProcurement(ofId: number) {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const result = await readSubcontractProcurementTx(tx, ofId);
        await tx.query('COMMIT');
        return result;
    }
    catch (error) {
        await tx.query('ROLLBACK');
        throw error;
    }
    finally {
        tx.release();
    }
}
function assertServiceProducer(current: { coveredByOfId: number | null }) {
    if (current.coveredByOfId) throw new HttpError(409, 'OF_COVERED_BY_CONSOLIDATION',
        'Les prestations de cet OF sont préparées dans son OF de regroupement.', { producerOfId: current.coveredByOfId });
}
export async function prepareSubcontractDemands(ofId: number, body: SubcontractDemandCommand, audit: AuditContext) {
    return consumableCommand({ ofId }, 'SUBCONTRACT_PREPARE_PURCHASES', body, audit, async tx => {
        const current = await readSubcontractProcurementTx(tx, ofId);
        assertServiceProducer(current);
        if (body.expectedVersion !== current.version) throw new HttpError(409, 'SUBCONTRACT_PROCUREMENT_CHANGED',
            'Les prestations, lots ou conditions fournisseur ont changé. Relisez la préparation.');
        const selected = body.selection ? await readSubcontractProcurementTx(tx, ofId, body.selection) : current;
        await savePurchasePreparationsTx(tx, selected.purchasePreparations, 'PRESTATION', ofId, selected.version, audit, { persistCovered: !!body.selection });
        return { prepared: selected.purchasePreparations.length };
    });
}
export async function prepareSubcontractProcurement(ofId: number, body: SubcontractProcurementCommand, audit: AuditContext) {
    return consumableCommand({ ofId }, 'SUBCONTRACT_PREPARE', body, audit, async (tx) => {
        const current = await readSubcontractProcurementTx(tx, ofId);
        assertServiceProducer(current);
        if (body.expectedVersion !== current.version)
            throw new HttpError(409, 'SUBCONTRACT_PROCUREMENT_CHANGED', 'Les origines, achats ou opérations ont changé. Relisez la préparation.');
        if (!current.of.hash)
            throw new HttpError(409, 'SUBCONTRACT_SNAPSHOT_REQUIRED', 'Validez le dossier technique de cet OF avant de préparer la sous-traitance.');
        if (current.hasDirectMaterial && !current.origins.length)
            throw new HttpError(409, 'SUBCONTRACT_MATERIAL_REQUIRED', 'Réservez les lots matière avant de préparer leurs lignes de sous-traitance.');
        const purchase = current.purchases.find(p => p.id === body.purchaseId), operation = current.operations.find(op => op.id === body.operationId), offer = current.offers.find(o => o.id === body.catalogueId);
        if (!purchase?.article_id || !operation || !offer || offer.articleId !== purchase.article_id || purchase.gamme_operation_id && purchase.gamme_operation_id !== operation.sourceId)
            throw new HttpError(422, 'SUBCONTRACT_PURCHASE_INVALID', 'Choisissez l’achat, sa phase de sous-traitance et les conditions fournisseur correspondantes.');
        if (body.destinationId && !current.destinations.some(d => d.id === body.destinationId))
            throw new HttpError(422, 'SUBCONTRACT_DESTINATION_INVALID', 'Choisissez un magasin existant.');
        assertSubcontractPieceUnit(offer.unit);
        const roots = body.rows.map(r => r.originId);
        if (new Set(roots).size !== roots.length || (current.origins.length ? roots.some(id => !id || !current.origins.some(o => o.id === id)) : roots.length !== 1 || roots[0] !== null))
            throw new HttpError(422, 'SUBCONTRACT_ORIGIN_INVALID', 'Choisissez une seule ligne pour chaque origine matière engagée dans cet OF.');
        if (current.drafts.some(d => d.operationId === operation.id && roots.includes(d.originId)))
            throw new HttpError(409, 'SUBCONTRACT_ORIGIN_ALREADY_PREPARED', 'Une ligne fournisseur couvre déjà cette origine et cette opération. Modifiez son brouillon.');
        const total = body.rows.reduce((n, r) => n + r.quantity, 0) + current.drafts.filter(d => d.operationId === operation.id).reduce((n, d) => n + d.quantity, 0);
        if (total > current.of.quantity)
            throw new HttpError(422, 'SUBCONTRACT_QUANTITY_EXCEEDED', 'La préparation dépasse la quantité de l’OF.');
        const predecessors = current.predecessorState.find(state => state.operationId === operation.id)?.predecessors ?? [];
        if (predecessors.length && predecessors.every(predecessor => predecessor.status === 'DONE') && predecessors.some(predecessor => total > predecessor.good))
            throw new HttpError(422, 'SUBCONTRACT_REAL_QUANTITY_EXCEEDED', 'Ajustez le brouillon aux quantités réellement conformes après clôture de l’opération précédente.');
        if (!body.due && offer.delay === null)
            throw new HttpError(422, 'SUBCONTRACT_DELAY_REQUIRED', 'Confirmez une date de retour ou un délai fournisseur avant de préparer les lignes.');
        const commands = await createMaterialDraftsTx(tx, body.rows.map(row => ({ type: 'SOUS_TRAITANCE' as const, needId: null, ofId, sourceRef: purchase.id, articleId: purchase.article_id!, designation: `${purchase.designation ?? purchase.nom ?? operation.label} · ${row.originId ? current.origins.find(o => o.id === row.originId)!.label : 'Sans MP directe'}`,
            supplierId: offer.supplierId, currency: offer.currency, destinationId: body.destinationId, unit: offer.unit, quantity: row.quantity, assigned: 0, price: offer.price, due: body.due, delay: offer.delay, catalogueId: offer.id, supplierReference: offer.reference, requirements: [], operation: operation.label,
            subcontract: { operationId: operation.id, materialOriginId: row.originId, snapshot: { purchase, operation, unit: offer.unit, origin: row.originId, quantity: row.quantity, reason: body.reason, technicalHash: current.of.hash, predecessors: current.predecessorState.find(s => s.operationId === operation.id) } } })), audit);
        const procurement = await readSubcontractProcurementTx(tx, ofId, { purchaseId: body.purchaseId, operationId: body.operationId,
            catalogueId: body.catalogueId, destinationId: body.destinationId, due: body.due });
        await savePurchasePreparationsTx(tx, procurement.purchasePreparations, 'PRESTATION', ofId, procurement.version, audit);
        return { commands };
    });
}
