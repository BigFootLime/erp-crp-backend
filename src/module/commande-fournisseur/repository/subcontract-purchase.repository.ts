import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { readMaterialOriginPolicyTx } from '../../production/repository/of-material-policy.repository';
import { assertSubcontractPieceUnit, assertSubcontractQuantityCeiling } from '../../subcontract/subcontract-procurement.domain';
type Db = Pick<PoolClient, 'query'>;
export async function assertSubcontractLineIdentityTx(tx: Db, lineId: string, patch: Record<string, unknown>) {
    const proof = (await tx.query<{
        of_id: number;
        article: string;
        unit: string;
    }>('SELECT of_id::int,preparation_snapshot->\'purchase\'->>\'article_id\' AS article,preparation_snapshot->>\'unit\' AS unit FROM public.subcontract_purchase_origins WHERE line_id=$1::uuid', [lineId])).rows[0];
    if (!proof)
        return;
    if ('type' in patch && patch.type !== 'SOUS_TRAITANCE' || 'of_id' in patch && Number(patch.of_id) !== proof.of_id || 'article_id' in patch && patch.article_id !== proof.article || 'unite' in patch && patch.unite !== proof.unit || 'unite_stock' in patch && patch.unite_stock !== proof.unit || 'coef_conversion' in patch && Number(patch.coef_conversion) !== 1)
        throw new HttpError(409, 'SUBCONTRACT_LINE_IDENTITY_LOCKED', 'Cette ligne conserve sa prestation, son OF et son unité. Annulez son brouillon pour préparer une autre identité.');
}
/** Dependency edges take precedence over the previous phase of the active route. */
export async function readSubcontractPredecessorsTx(tx: Db, operationId: string) {
    return (await tx.query<{
        id: string;
        label: string;
        status: string;
        good: number;
    }>(`
    WITH route AS (
      SELECT o.id,lag(o.id) OVER(ORDER BY o.phase,o.id) AS previous
      FROM public.of_operations o WHERE o.of_id=(SELECT of_id FROM public.of_operations WHERE id=$1::uuid)
        AND o.status::text<>'CANCELLED' AND(o.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=o.revision_id AND r.statut='ACTIVE'))
    ), edges AS (
      SELECT substring(d.predecessor_id from 4)::uuid AS id FROM public.planning_operation_dependencies d
      WHERE d.successor_id='op:'||$1 AND d.predecessor_id LIKE 'op:%'
      UNION SELECT previous FROM route WHERE id=$1::uuid AND previous IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM public.planning_operation_dependencies d WHERE d.successor_id='op:'||$1 AND d.predecessor_id LIKE 'op:%')
    ) SELECT p.id::text,p.designation AS label,p.status::text,
      COALESCE((SELECT sum(q.qty_good) FROM public.production_quantity_declarations q WHERE q.operation_id=p.id),0)::float8 AS good
    FROM edges e JOIN public.of_operations p ON p.id=e.id ORDER BY p.phase,p.id`, [operationId])).rows;
}
/** Purchase validation is stricter than a partial internal operation start. */
export async function assertSubcontractPurchaseReadyTx(tx: Db, orderId: string) {
    const lines = (await tx.query<{
        id: string;
        of_id: number;
        of_quantity: number;
        unit: string;
        operation_of_id: number | null;
        active: boolean;
        operation_id: string | null;
        material_origin_id: string | null;
        quantity: number;
        due: string | null;
        delay: number | null;
        status: string | null;
    }>(`
    SELECT l.id::text,l.of_id::int,p.operation_id::text,p.material_origin_id::text,l.quantite::float8 AS quantity,
      COALESCE(l.date_besoin,l.date_promesse,c.date_besoin,c.date_promesse)::text AS due,l.delai_jours AS delay,o.status::text,o.of_id::int AS operation_of_id,
      (o.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=o.revision_id AND r.statut='ACTIVE')) AS active,
      fab.quantite_lancee::float8 AS of_quantity,l.unite AS unit
    FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id
    LEFT JOIN public.subcontract_purchase_origins p ON p.line_id=l.id LEFT JOIN public.of_operations o ON o.id=p.operation_id
    JOIN public.ordres_fabrication fab ON fab.id=l.of_id
    WHERE c.id=$1::uuid AND l.type='SOUS_TRAITANCE' AND l.of_id IS NOT NULL AND l.statut_ligne='ACTIVE' ORDER BY l.of_id,l.id`, [orderId])).rows;
    for (const line of lines) {
        if (!line.operation_id || !line.status || line.status === 'CANCELLED' || !line.active || line.operation_of_id !== line.of_id)
            throw new HttpError(409, 'SUBCONTRACT_ORIGIN_REQUIRED', 'Préparez la sous-traitance depuis l’OF, avec une ligne par origine matière.', { lineId: line.id });
        if (!Number.isInteger(line.quantity) || line.quantity <= 0)
            throw new HttpError(422, 'SUBCONTRACT_PIECE_QUANTITY_REQUIRED', 'Chaque origine doit porter un nombre entier de pièces.', { lineId: line.id });
        assertSubcontractPieceUnit(line.unit);
        const policy = await readMaterialOriginPolicyTx(tx, [line.of_id]);
        if (policy.usedOrigins.length ? !line.material_origin_id || !policy.usedOrigins.includes(line.material_origin_id) : line.material_origin_id !== null)
            throw new HttpError(409, 'SUBCONTRACT_ORIGIN_CHANGED', 'Les origines matière ne correspondent plus à la ligne préparée.', { lineId: line.id });
        const predecessors = await readSubcontractPredecessorsTx(tx, line.operation_id);
        const total = Number((await tx.query(`SELECT COALESCE(sum(l.quantite),0)::float8 AS quantity FROM public.subcontract_purchase_origins p
      JOIN public.commande_fournisseur_ligne l ON l.id=p.line_id JOIN public.commande_fournisseur c ON c.id=l.commande_id
      WHERE p.operation_id=$1::uuid AND l.statut_ligne='ACTIVE' AND c.statut<>'ANNULEE'`, [line.operation_id])).rows[0].quantity);
        assertSubcontractQuantityCeiling(total, line.of_quantity, predecessors);
        if (!line.due && line.delay === null)
            throw new HttpError(422, 'SUBCONTRACT_DELAY_REQUIRED', 'Confirmez une date ou un délai pour chaque ligne de sous-traitance.', { lineId: line.id });
    }
}
