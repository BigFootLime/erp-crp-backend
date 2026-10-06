import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { preparationAudit } from './production-preparation.repository';
import type { AuditContext } from './production.repository';
import { createRecursiveOrdresFabrication } from '../domain/of-generation';
import { materialPropertiesFingerprint } from '../domain/of-material';
import { assertDefinitiveLoss } from '../domain/definitive-loss';
import type { ProductionLossCommand } from '../validators/production-loss.validators';
type Db = Pick<PoolClient, 'query'>;
async function readLossesTx(tx: Db, ofId: number) {
    const of = (await tx.query<{
        id: number;
        numero: string;
        piece_technique_id: string;
        piece_technique_version_id: string | null;
        article_id: string | null;
        client_id: string | null;
        affaire_id: number | null;
        commande_id: number | null;
        commande_ligne_id: number | null;
    }>(`SELECT id::int,numero,piece_technique_id::text,piece_technique_version_id::text,article_id::text,client_id,affaire_id::int,commande_id::int,commande_ligne_id::int
     FROM public.ordres_fabrication WHERE id=$1`, [ofId])).rows[0];
    if (!of)
        throw new HttpError(404, 'OF_NOT_FOUND', 'OF introuvable.');
    const operations = (await tx.query<{
        id: string;
        label: string;
        status: string;
        phase: number;
        loss: number;
        covered: number;
        potential: boolean;
    }>(`
    SELECT o.id::text,o.designation AS label,o.status::text,o.phase,COALESCE((SELECT sum(qty_scrap) FROM public.production_quantity_declarations WHERE operation_id=o.id),0)::float8 AS loss,
      COALESCE((SELECT sum(c.quantity) FROM public.production_loss_complements c JOIN public.ordres_fabrication f ON f.id=c.complement_of_id
        WHERE c.source_operation_id=o.id AND f.statut::text<>'ANNULE'),0)::float8 AS covered,
      EXISTS(SELECT 1 FROM public.production_material_debits d WHERE d.operation_id=o.id AND d.quantity_kind='POTENTIAL' AND d.compensates_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM public.production_material_debits correction WHERE correction.compensates_id=d.id)) AS potential
    FROM public.of_operations o WHERE o.of_id=$1 AND (o.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=o.revision_id AND r.statut='ACTIVE')) ORDER BY o.phase,o.id`, [ofId])).rows;
    const complements = (await tx.query(`SELECT c.id::text,c.source_operation_id::text AS "operationId",c.complement_of_id::int AS "ofId",f.numero,
    c.quantity::float8,c.reason,c.created_at AS "createdAt",f.statut::text AS status,u.username AS actor
    FROM public.production_loss_complements c JOIN public.ordres_fabrication f ON f.id=c.complement_of_id JOIN public.users u ON u.id=c.created_by
    WHERE c.source_of_id=$1 ORDER BY c.created_at,c.id`, [ofId])).rows;
    return { of, operations: operations.map(op => ({ ...op, remaining: Math.max(0, op.loss - op.covered) })), complements,
        version: materialPropertiesFingerprint({ of, operations, complements }) };
}
export async function readProductionLosses(ofId: number) {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const result = await readLossesTx(tx, ofId);
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
export async function createLossComplement(ofId: number, body: ProductionLossCommand, audit: AuditContext) {
    return withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
        await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`production-loss:${body.idempotencyKey}`]);
        const request = { ofId, operationId: body.operationId, quantity: body.quantity, reason: body.reason, actor: audit.user_id };
        const previous = (await tx.query<{
            complement_of_id: number;
            request_payload: unknown;
        }>('SELECT complement_of_id::int,request_payload FROM public.production_loss_complements WHERE request_key=$1::uuid', [body.idempotencyKey])).rows[0];
        if (previous) {
            if (materialPropertiesFingerprint(previous.request_payload) !== materialPropertiesFingerprint(request))
                throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Cette clé correspond à un autre complément.');
            return { ofId: previous.complement_of_id, replayed: true };
        }
        await tx.query('SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE', [ofId]);
        await tx.query('SELECT id FROM public.of_operations WHERE id=$1::uuid AND of_id=$2 FOR UPDATE', [body.operationId, ofId]);
        const current = await readLossesTx(tx, ofId);
        if (current.version !== body.expectedVersion)
            throw new HttpError(409, 'PRODUCTION_LOSS_CHANGED', 'Les pertes ou leurs compléments ont changé. Relisez le bilan.');
        const operation = current.operations.find(op => op.id === body.operationId);
        if (!operation)
            throw new HttpError(404, 'OF_OPERATION_NOT_FOUND', 'Opération introuvable dans cet OF.');
        assertDefinitiveLoss({ ...operation, quantity: body.quantity });
        const generated = await createRecursiveOrdresFabrication(tx, { source_type: 'MANUAL', commande_id: current.of.commande_id, commande_numero: null,
            commande_ligne_id: current.of.commande_ligne_id, livraison_affaire_id: current.of.affaire_id, client_id: current.of.client_id,
            root_article_id: current.of.article_id, root_piece_technique_id: current.of.piece_technique_id, root_pinned_version_id: current.of.piece_technique_version_id,
            qty_to_produce: body.quantity, user_id: audit.user_id, force_preparation: true });
        await tx.query(`INSERT INTO public.production_loss_complements(source_of_id,source_operation_id,complement_of_id,quantity,loss_snapshot,reason,request_key,request_payload,created_by)
      VALUES($1,$2::uuid,$3,$4,$5::jsonb,$6,$7::uuid,$8::jsonb,$9)`, [ofId, body.operationId, generated.root_of_id, body.quantity, JSON.stringify(operation), body.reason, body.idempotencyKey, JSON.stringify(request), audit.user_id]);
        await preparationAudit(tx, audit, ofId, 'production.loss.complement', { operation, complement_of_id: generated.root_of_id, quantity: body.quantity, reason: body.reason });
        await preparationAudit(tx, audit, generated.root_of_id, 'production.of.create', { source_of_id: ofId, source_operation_id: body.operationId, quantity: body.quantity, reason: body.reason, preparation_required: true });
        return { ofId: generated.root_of_id, replayed: false };
    });
}
