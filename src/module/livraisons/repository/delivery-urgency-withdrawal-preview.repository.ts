import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { readUrgencyApprovalTx } from '../../planning/repository/urgency-approval.repository';
export async function readUrgencyWithdrawalTx(tx: Pick<PoolClient, 'query'>, requestId: string) {
    const current = await readUrgencyApprovalTx(tx, requestId);
    const approval = current.request.approved_id ? (await tx.query<{
        id: string;
        request_version: number;
        evidence: {
            planning_basis?: string;
        };
    }>(`SELECT id::text,request_version,evidence FROM public.delivery_urgency_approvals
    WHERE id=$1::uuid AND request_id=$2::uuid`, [current.request.approved_id, requestId])).rows[0] : null;
    const issues = [...current.response.issues];
    if (current.request.status !== 'APPROVED' || !approval || approval.request_version !== current.request.version - 1)
        issues.push({ code: 'URGENCY_APPROVAL_REQUIRED', message: 'Le planificateur doit approuver cette récupération.' });
    else if (approval.evidence.planning_basis !== current.basis)
        issues.push({ code: 'URGENCY_APPROVAL_OBSOLETE', message: 'Le dossier ou les créneaux ont changé. Faites confirmer la récupération par le planificateur.' });
    const previewHash = createHash('sha256').update(JSON.stringify({
        requestVersion: current.request.version, approvalId: approval?.id ?? null,
        current: current.response.preview_hash, basis: current.basis, issues,
    })).digest('hex');
    return { current, approval, response: {
            request_id: requestId, request_version: current.request.version, approval_id: approval?.id ?? null,
            status: current.request.status, quantity: current.request.quantity, preview_hash: previewHash,
            can_withdraw: issues.length === 0, issues, recoveries: current.response.recoveries,
            donors: current.donorPlan.response.donors, checked_at: current.response.checked_at,
        } };
}
export async function repoPreviewUrgencyWithdrawal(requestId: string) {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const { response } = await readUrgencyWithdrawalTx(tx, requestId);
        await tx.query('COMMIT');
        return response;
    }
    catch (error) {
        await tx.query('ROLLBACK');
        throw error;
    }
    finally {
        tx.release();
    }
}
