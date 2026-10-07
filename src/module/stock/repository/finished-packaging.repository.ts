import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { coverageFingerprint } from '../../production/domain/of-material';
import { assertOperationalLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';
import { packagingPolicySchema, packagingPortions } from '../domain/finished-packaging';
import type { PackagingCommand } from '../validators/finished-packaging.validators';
import { randomUUID } from 'node:crypto';
import { repoFindActiveLabel, repoFindEntity, repoInsertLabel, repoInsertAudit } from '../../identification/identification.repository';
import { buildHumanCode } from '../../identification/domain/identification';
type Db = Pick<PoolClient, 'query'>;
async function readPackagingTx(tx: Db, lotId: string) {
    const outputs = (await tx.query<{
        ofId: number;
        number: string;
        hash: string | null;
        policy: unknown;
        received: number;
        versionId: string | null;
    }>(`SELECT o.id::int AS "ofId",o.numero AS number,o.technical_snapshot_sha256 AS hash,
    o.technical_snapshot->'preparation_evidence'->'version'->'packaging_policy' AS policy,sum(output.qty_ok)::float8 AS received,
    o.piece_technique_version_id::text AS "versionId" FROM public.of_output_lots output JOIN public.ordres_fabrication o ON o.id=output.of_id
    WHERE output.lot_id=$1::uuid GROUP BY o.id ORDER BY o.id`, [lotId])).rows;
    const lot = (await tx.query<{
        id: string;
        label: string;
        articleCode: string;
        articleDesignation: string;
        scope: string;
        physical: number;
        index: string | null;
        internalVersion: number | null;
    }>(`SELECT l.id::text,l.lot_code AS label,a.code AS "articleCode",a.designation AS "articleDesignation",
    COALESCE(l.origin_stock_scope,l.source_scope,l.stock_scope,'NEW') AS scope,
    COALESCE((SELECT sum(b.qty_total) FROM public.stock_batches b WHERE b.lot_id=l.id),0)::float8 AS physical,
    v.indice_externe_original AS index,v.version_interne::int AS "internalVersion"
    FROM public.lots l JOIN public.articles a ON a.id=l.article_id LEFT JOIN public.piece_technique_versions v ON v.id=l.piece_technique_version_id WHERE l.id=$1::uuid`, [lotId])).rows[0];
    if (!lot)
        throw new HttpError(404, 'LOT_NOT_FOUND', 'Lot introuvable.');
    const records = (await tx.query<{
        id: string;
        quantity: number;
        portions: number[];
        policy: unknown;
        reason: string;
        createdAt: string;
        voided: boolean;
    }>(`SELECT p.id::text,p.quantity,p.portion_quantities AS portions,p.policy_snapshot AS policy,p.reason,p.created_at::text AS "createdAt",v.id IS NOT NULL AS voided
    FROM public.finished_lot_packaging p LEFT JOIN public.finished_packaging_voids v ON v.packaging_id=p.id WHERE p.lot_id=$1::uuid ORDER BY p.created_at,p.id`, [lotId])).rows;
    const source = outputs.length === 1 ? outputs[0] : null;
    const parsed = packagingPolicySchema.safeParse(source?.policy);
    return { lot, source, policy: parsed.success ? parsed.data : null, records,
        remaining: source ? Math.max(0, Math.min(lot.physical, source.received - records.filter(r => !r.voided).reduce((n, r) => n + r.quantity, 0))) : 0 };
}
export async function readFinishedPackaging(lotId: string) { const tx = await pool.connect(); try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readPackagingTx(tx, lotId);
    await tx.query('COMMIT');
    return result;
}
catch (error) {
    await tx.query('ROLLBACK');
    throw error;
}
finally {
    tx.release();
} }
export async function createFinishedPackaging(lotId: string, body: PackagingCommand, actor: number) {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['finished-packaging:' + body.idempotencyKey]);
        const hash = coverageFingerprint({ lotId, body, actor }), previous = (await tx.query<{
            id: string;
            request_hash: string;
        }>('SELECT id::text,request_hash FROM public.finished_lot_packaging WHERE idempotency_key=$1::uuid', [body.idempotencyKey])).rows[0];
        if (previous) {
            if (previous.request_hash !== hash)
                throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Cette confirmation correspond à un autre conditionnement.');
            await tx.query('COMMIT');
            return { id: previous.id, replayed: true };
        }
        // Same entitlement-before-stock lock order as production receipts and shipment.
        await assertOperationalLotQualityEligibility({ client: tx, lotId, qty: body.quantity, purpose: 'RESERVE' });
        await tx.query('SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE', [lotId]);
        await tx.query('SELECT id FROM public.stock_batches WHERE lot_id=$1::uuid ORDER BY id FOR UPDATE', [lotId]);
        const current = await readPackagingTx(tx, lotId);
        if (!current.source?.hash)
            throw new HttpError(409, 'PACKAGING_PRODUCTION_SOURCE_REQUIRED', 'Le conditionnement exige un lot issu d’un OF au dossier figé.');
        if (body.quantity > current.remaining)
            throw new HttpError(409, 'PACKAGING_QUANTITY_CHANGED', 'La quantité physique restante à conditionner a changé. Relisez le lot.');
        if (current.policy && body.legacyPolicy)
            throw new HttpError(422, 'PACKAGING_FROZEN_POLICY', 'Le conditionnement défini dans l’OF figé doit être conservé.');
        const policy = current.policy ?? body.legacyPolicy;
        if (!policy)
            throw new HttpError(422, 'PACKAGING_POLICY_REQUIRED', 'Cet ancien OF ne définit pas le conditionnement. Confirmez explicitement sa règle de reprise.');
        let portions: number[];
        try {
            portions = packagingPortions(body.quantity, policy);
        }
        catch (error) {
            throw new HttpError(422, 'PACKAGING_PORTIONS_INVALID', error instanceof Error ? error.message : 'Conditionnement invalide.');
        }
        const row = (await tx.query<{
            id: string;
        }>(`INSERT INTO public.finished_lot_packaging(lot_id,of_id,policy_snapshot,portion_quantities,quantity,technical_hash,reason,created_by,idempotency_key,request_hash)
      VALUES($1::uuid,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9::uuid,$10) RETURNING id::text`, [lotId, current.source.ofId, JSON.stringify({ ...policy, source: current.policy ? 'FROZEN_PT' : 'LEGACY_REVIEW', label: { ...current.lot, ofNumber: current.source.number } }), JSON.stringify(portions), body.quantity, current.source.hash, body.reason, actor, body.idempotencyKey, hash])).rows[0];
        if (!await repoFindActiveLabel('STOCK_LOT', lotId, tx)) {
            const entity = await repoFindEntity('STOCK_LOT', lotId, tx), labelActor = { user_id: actor, role: null, request_id: null, correlation_id: null };
            const label = await repoInsertLabel(tx, { public_id: randomUUID(), entity, human_code: buildHumanCode('STOCK_LOT', entity.canonical_code), actor: labelActor });
            await repoInsertAudit(tx, { actor: labelActor, action: 'IDENTIFICATION_LABEL_ISSUED', entity_type: 'STOCK_LOT', entity_id: lotId, label_id: label.id, details: { packagingId: row.id } });
        }
        await tx.query(`INSERT INTO public.erp_audit_logs(user_id,action,entity_type,entity_id,details) VALUES($1,'stock.finished-packaging.create','LOT',$2,$3::jsonb)`, [actor, lotId, JSON.stringify({ packagingId: row.id, portions, reason: body.reason })]);
        await tx.query('COMMIT');
        return { id: row.id, replayed: false };
    }
    catch (error) {
        await tx.query('ROLLBACK');
        throw error;
    }
    finally {
        tx.release();
    }
}
export async function recordPackagingPrint(lotId: string, packagingId: string, key: string, reason: string, actor: number) {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['packaging-print:' + key]);
        const record = (await tx.query<{
            id: string;
        }>(`SELECT p.id::text FROM public.finished_lot_packaging p WHERE p.id=$1::uuid AND p.lot_id=$2::uuid AND NOT EXISTS(SELECT 1 FROM public.finished_packaging_voids v WHERE v.packaging_id=p.id)`, [packagingId, lotId])).rows[0];
        if (!record)
            throw new HttpError(404, 'PACKAGING_NOT_FOUND', 'Conditionnement introuvable pour ce lot.');
        const prior = (await tx.query<{
            packaging_id: string;
            reason: string;
            created_by: number;
        }>('SELECT packaging_id::text,reason,created_by FROM public.finished_packaging_print_intents WHERE idempotency_key=$1::uuid', [key])).rows[0];
        if (prior && (prior.packaging_id !== packagingId || prior.reason !== reason || prior.created_by !== actor))
            throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Cette clé correspond à une autre demande d’impression.');
        if (!prior)
            await tx.query('INSERT INTO public.finished_packaging_print_intents(packaging_id,reason,created_by,idempotency_key) VALUES($1::uuid,$2,$3,$4::uuid)', [packagingId, reason, actor, key]);
        await tx.query('COMMIT');
        return { packagingId, replayed: !!prior };
    }
    catch (error) {
        await tx.query('ROLLBACK');
        throw error;
    }
    finally {
        tx.release();
    }
}
export async function voidFinishedPackaging(lotId: string, packagingId: string, key: string, reason: string, actor: number) {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
        await tx.query('SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE', [lotId]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['packaging-void:' + key]);
        const record = (await tx.query<{
            id: string;
        }>(`SELECT id::text FROM public.finished_lot_packaging WHERE id=$1::uuid AND lot_id=$2::uuid FOR UPDATE`, [packagingId, lotId])).rows[0];
        if (!record)
            throw new HttpError(404, 'PACKAGING_NOT_FOUND', 'Conditionnement introuvable.');
        const hash = coverageFingerprint({ lotId, packagingId, key, reason, actor });
        const previous = (await tx.query<{
            request_hash: string;
        }>('SELECT request_hash FROM public.finished_packaging_voids WHERE packaging_id=$1::uuid OR idempotency_key=$2::uuid', [packagingId, key])).rows[0];
        if (previous && previous.request_hash !== hash)
            throw new HttpError(409, 'PACKAGING_ALREADY_VOIDED', 'Ce conditionnement a déjà été annulé.');
        if (!previous)
            await tx.query('INSERT INTO public.finished_packaging_voids(packaging_id,reason,created_by,idempotency_key,request_hash) VALUES($1::uuid,$2,$3,$4::uuid,$5)', [packagingId, reason, actor, key, hash]);
        await tx.query('COMMIT');
        return { packagingId, replayed: !!previous };
    }
    catch (error) {
        await tx.query('ROLLBACK');
        throw error;
    }
    finally {
        tx.release();
    }
}
