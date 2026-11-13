import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { coverageFingerprint } from '../../production/domain/of-material';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import type { LegacyDocumentCommand } from '../validators/legacy-documents.validators';
export async function readLegacyDocuments(lotId: string) {
    const lot = (await pool.query<{
        scope: string;
        label: string;
    }>('SELECT COALESCE(origin_stock_scope,source_scope,stock_scope,\'NEW\') AS scope,lot_code AS label FROM public.lots WHERE id=$1::uuid', [lotId])).rows[0];
    if (!lot)
        throw new HttpError(404, 'LOT_NOT_FOUND', 'Lot introuvable.');
    const documents = (await pool.query(`SELECT id::text,type,label,location,reason,created_at::text AS "createdAt",created_by FROM public.old_stock_document_references WHERE lot_id=$1::uuid ORDER BY created_at,id`, [lotId])).rows;
    return { lotId, ...lot, documents };
}
export async function appendLegacyDocument(lotId: string, command: LegacyDocumentCommand, actor: number) {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['old-stock-document:' + command.idempotencyKey]);
        const hash = coverageFingerprint({ lotId, command, actor });
        const previous = (await tx.query<{
            request_hash: string;
            id: string;
        }>('SELECT request_hash,id::text FROM public.old_stock_document_references WHERE idempotency_key=$1::uuid', [command.idempotencyKey])).rows[0];
        if (previous) {
            if (previous.request_hash !== hash)
                throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Cette confirmation désigne un autre document.');
            await tx.query('COMMIT');
            return { id: previous.id, replayed: true };
        }
        const lot = (await tx.query<{
            scope: string;
        }>('SELECT COALESCE(origin_stock_scope,source_scope,stock_scope,\'NEW\') AS scope FROM public.lots WHERE id=$1::uuid FOR UPDATE', [lotId])).rows[0];
        if (!lot)
            throw new HttpError(404, 'LOT_NOT_FOUND', 'Lot introuvable.');
        if (lot.scope !== 'OLD')
            throw new HttpError(422, 'OLD_STOCK_REQUIRED', 'Les références serveur historiques concernent un lot OLD.');
        const row = (await tx.query<{
            id: string;
        }>(`INSERT INTO public.old_stock_document_references(lot_id,type,label,location,reason,created_by,idempotency_key,request_hash)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8) RETURNING id::text`, [lotId, command.type, command.label, command.location, command.reason, actor, command.idempotencyKey, hash])).rows[0];
        await repoInsertAuditLog({
            user_id: actor, tx, ip: null, user_agent: null, device_type: null, os: null, browser: null,
            body: { event_type: 'ACTION', action: 'stock.old-document.append', page_key: 'stock',
                entity_type: 'LOT', entity_id: lotId,
                details: { referenceId: row.id, type: command.type, reason: command.reason } },
        });
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
