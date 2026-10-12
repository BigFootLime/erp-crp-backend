import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { enqueueEntityChanged } from '../../../shared/realtime/realtime-outbox.service';
import { readCentralSnapshot, readCentralDependencies } from './planning-central.repository';
import { readPlanningCoverageTx } from './planning-coverage.repository';
import { dependencyClosure } from '../domain/central-dependencies';
import { evaluateUrgencyRecoveryApproval, type UrgencyRecoveryEvidence } from '../domain/urgency-recovery-approval';
import { readOfDossierTx } from '../../production/repository/of-dossier.repository';
import { readOfComponentCoverageTx } from '../../production/repository/of-component-coverage.repository';
import { evaluateRecoveryComponents } from '../domain/urgency-recovery-components';
import { readDeliveryUrgencyPlan } from '../../livraisons/repository/delivery-urgency.repository';
import { parseCumpDecimal } from '../../stock/domain/cump-decimal';
import { preparationAudit } from '../../production/repository/production-preparation.repository';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import type { AuditContext } from '../../production/repository/production.repository';
type Db = Pick<PoolClient, 'query'>;
type RequestRow = {
    id: string;
    beneficiary_allocation_id: number;
    quantity: string;
    status: string;
    version: number;
    approved_id: string | null;
};
type RecoveryRow = {
    id: string;
    donor_allocation_id: number;
    recovery_of_id: number;
    quantity: string;
    protected_due_date: string;
    protected_before: string;
    initial_ar_due_date: string;
    donor_snapshot: {
        commande_id: number;
        commande_ligne_id: number;
        livraison_affaire_id: number;
        piece_technique_id: string;
        technical_version_id: string;
    };
    commande_id: number;
    commande_ligne_id: number;
    affaire_id: number;
    client_id: string;
    article_id: string;
    piece_technique_id: string;
    technical_version_id: string;
    root_of_id: number;
    of_quantity: string;
};
type SourceRow = {
    id: string;
    recovery_id: string;
    donor_reservation_id: string;
    quantity: string;
};
export async function readUrgencyApprovalTx(tx: Db, requestId: string) {
    const request = (await tx.query<RequestRow>(`SELECT id::text,beneficiary_allocation_id::int,quantity::text,status,version,approved_id::text
    FROM public.delivery_urgency_requests WHERE id=$1::uuid`, [requestId])).rows[0];
    if (!request)
        throw new HttpError(404, 'URGENCY_REQUEST_NOT_FOUND', 'Demande urgente introuvable.');
    if (!['WAITING_PLANNER', 'APPROVED'].includes(request.status))
        throw new HttpError(409, 'URGENCY_REQUEST_CLOSED', 'Cette demande n’attend plus d’approbation.');
    const recoveries = (await tx.query<RecoveryRow>(`SELECT recovery.id::text,recovery.donor_allocation_id::int,recovery.recovery_of_id::int,
    recovery.quantity::text,recovery.protected_due_date::text,
    (recovery.protected_due_date::timestamp AT TIME ZONE 'Europe/Paris')::text AS protected_before,
    recovery.initial_ar_due_date::text,recovery.donor_snapshot,
    producer.commande_id::int,producer.commande_ligne_id::int,producer.affaire_id::int,producer.client_id::text,producer.article_id::text,
    producer.piece_technique_id::text,COALESCE(producer.piece_technique_version_id,NULLIF(producer.technical_preparation->>'selected_version_id','')::uuid)::text AS technical_version_id,
    COALESCE(producer.root_of_id,producer.id)::int AS root_of_id,producer.quantite_lancee::text AS of_quantity
    FROM public.delivery_urgency_recoveries recovery JOIN public.ordres_fabrication producer ON producer.id=recovery.recovery_of_id
    WHERE recovery.request_id=$1::uuid ORDER BY recovery.donor_allocation_id,recovery.id`, [requestId])).rows;
    const sources = (await tx.query<SourceRow>(`SELECT source.id::text,source.recovery_id::text,source.donor_reservation_id::text,source.quantity::text
    FROM public.delivery_urgency_sources source JOIN public.delivery_urgency_recoveries recovery ON recovery.id=source.recovery_id
    WHERE recovery.request_id=$1::uuid ORDER BY source.donor_reservation_id`, [requestId])).rows;
    if (!recoveries.length || !sources.length)
        throw new HttpError(409, 'URGENCY_RECOVERY_MISSING', 'La demande n’a pas de récupération complète.');
    const donorPlan = await readDeliveryUrgencyPlan(tx, request.beneficiary_allocation_id, request.quantity, { requestId, sourceReservationIds: sources.map(s => s.donor_reservation_id) });
    const proposed = new Map(donorPlan.response.donors.map(d => [d.reservation_id, d.proposed_quantity]));
    const donorIssues: Array<{
        code: string;
        message: string;
    }> = [];
    if (parseCumpDecimal(donorPlan.response.free_quantity) > 0n)
        donorIssues.push({ code: 'URGENCY_FREE_STOCK_AVAILABLE', message: 'Du stock libre est maintenant disponible. Réservez-le avant de prélever sur une autre affaire.' });
    if (sources.some(source => parseCumpDecimal(proposed.get(source.donor_reservation_id) ?? '0') < parseCumpDecimal(source.quantity)))
        donorIssues.push({ code: 'URGENCY_DONOR_CHANGED', message: 'Une quantité donneuse n’est plus utilisable ou disponible. Reprenez la proposition.' });
    const roots = recoveries.map(r => r.recovery_of_id);
    const tree = (await tx.query<{
        id: number;
        root_of_id: number;
        quantity: number;
    }>(`SELECT id::int,COALESCE(root_of_id,id)::int AS root_of_id,quantite_lancee::float8 AS quantity
    FROM public.ordres_fabrication WHERE (id=ANY($1::bigint[]) OR root_of_id=ANY($1::bigint[])) AND statut<>'ANNULE' ORDER BY id`, [roots])).rows;
    const dossiers = await Promise.all(tree.map(async (of) => ({ of, dossier: await readOfDossierTx(tx, of.id) })));
    const evidence: UrgencyRecoveryEvidence[] = [];
    for (const recovery of recoveries) {
        const source = donorPlan.donors.find(d => d.allocation_id === recovery.donor_allocation_id);
        const matching = dossiers.filter(d => d.of.root_of_id === recovery.recovery_of_id);
        const currentBoundary = source?.protected_due_date ? (await tx.query<{
            boundary: string;
        }>("SELECT ($1::date::timestamp AT TIME ZONE 'Europe/Paris')::text AS boundary", [source.protected_due_date])).rows[0].boundary : null;
        const original = recovery.donor_snapshot;
        evidence.push({
            recovery_id: recovery.id, of_id: recovery.recovery_of_id, of_ids: matching.map(d => d.of.id), quantity: recovery.quantity,
            protected_before: recovery.protected_before, current_protected_before: currentBoundary,
            dossier_complete: matching.length > 0 && matching.every(d => d.dossier.status === 'COMPLETE'),
            identity_matches: !!source && recovery.root_of_id === recovery.recovery_of_id && recovery.client_id === donorPlan.context.client_id
                && recovery.article_id === donorPlan.context.article_id && recovery.commande_id === original.commande_id
                && recovery.commande_ligne_id === original.commande_ligne_id && recovery.affaire_id === original.livraison_affaire_id
                && recovery.piece_technique_id === original.piece_technique_id && recovery.technical_version_id === original.technical_version_id
                && source.technical_version_id === original.technical_version_id && parseCumpDecimal(recovery.of_quantity) === parseCumpDecimal(recovery.quantity),
            operation_ids: matching.flatMap(d => d.dossier.operations.map(o => o.id)),
        });
    }
    const now = new Date().toISOString(), from = new Date(new Date(now).setUTCHours(0, 0, 0, 0)).toISOString();
    const maximum = Math.max(...evidence.map(r => Date.parse(r.protected_before)), Date.parse(now) + 86400000);
    const to = new Date(Math.min(maximum + 86400000, Date.parse(from) + 367 * 86400000)).toISOString();
    const ids = evidence.flatMap(r => r.operation_ids.map(id => `op:${id}`));
    const dependencies = await readCentralDependencies(tx);
    let included: string[];
    try {
        included = [...dependencyClosure(dependencies, ids, 'both')];
    }
    catch {
        throw new HttpError(422, 'PLANNING_CHAIN_TOO_DENSE', 'Cette chaîne dépasse 10 000 opérations.');
    }
    const base = { from, to, limit: 10000, includeTaskIds: included };
    const selected = await readCentralSnapshot({ ...base, taskIdsOnly: true }, tx, false);
    const resources = new Set(selected.tasks.flatMap(t => t.resourceIds));
    const capacities = new Set(selected.resources.filter(r => resources.has(r.id)).map(r => r.capacityId ?? r.id));
    const capacityResourceIds = selected.resources.filter(r => resources.has(r.id) || capacities.has(r.capacityId ?? r.id)).map(r => r.id);
    const snapshot = await readCentralSnapshot({ ...base, capacityResourceIds }, tx, false);
    const targets = new Set(tree.map(of => of.id));
    Object.assign(snapshot, await readPlanningCoverageTx(tx, snapshot.tasks.filter(t => t.ofId !== null && targets.has(t.ofId)), now));
    const assemblyOfIds = [...new Set(snapshot.tasks.filter(t => t.ofId !== null && targets.has(t.ofId) && t.operationType === 'ASSEMBLAGE').map(t => t.ofId!))];
    const components = [];
    for (const ofId of assemblyOfIds)
        components.push(await readOfComponentCoverageTx(tx, ofId, true));
    const evaluation = evaluateUrgencyRecoveryApproval({ recoveries: evidence, snapshot, now, allowExecution: request.status === 'APPROVED' });
    if (selected.nextCursor)
        donorIssues.push({ code: 'URGENCY_PLANNING_TRUNCATED', message: 'La chaîne de récupération dépasse la fenêtre de contrôle.' });
    const issues = [...donorIssues, ...evaluation.issues, ...evaluateRecoveryComponents(components, tree, snapshot)];
    // Generated-at timestamps and a sliding "available now" timestamp are not versions.
    const material = snapshot.demands.map(d => ({
        ...d, coverage: d.coverage ? {
            ...d.coverage,
            availableAt: d.coverage.availableAt === now ? 'NOW' : d.coverage.availableAt
        } : undefined
    }));
    const fingerprint = createHash('sha256').update(JSON.stringify({
        request: { id: request.id, allocation: request.beneficiary_allocation_id, quantity: request.quantity }, recoveries, sources,
        donor_hash: donorPlan.response.preview_hash, evidence, dossierVersions: dossiers.map(d => [d.of.id, d.dossier.version]),
        planning_revision: snapshot.revision, tasks: snapshot.tasks.map(t => [t.id, t.version, t.committed, t.resourceIds, t.actual]),
        resources: snapshot.resources.map(r => [r.id, r.version]), material, components: components.map(c => [c.ofId, c.version])
    })).digest('hex');
    // Approval binds the production definition and committed slots, not a global revision
    // or production counters that naturally evolve while the approved work is carried out.
    const basis = createHash('sha256').update(JSON.stringify({
        recoveries: evidence.map(r => [r.recovery_id,r.of_id,r.of_ids,r.quantity,r.protected_before,r.operation_ids]),
        dossiers: dossiers.map(d => [d.of.id,d.dossier.sourceHash]),
        commitments: snapshot.tasks.filter(t => targets.has(t.ofId ?? -1))
            .map(t => [t.id,t.committed,t.resourceIds]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))),
    })).digest('hex');
    return {
        request, recoveries, sources, donorPlan, snapshot, evidence, basis, response: {
            request_id: request.id, request_version: request.version,
            status: request.status, preview_hash: fingerprint, planning_revision: snapshot.revision, can_approve: issues.length === 0,
            can_withdraw: false as const, issues, recoveries: evaluation.recoveries, checked_at: now
        }
    };
}
export async function previewUrgencyApproval(requestId: string) {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const { response } = await readUrgencyApprovalTx(tx, requestId);
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
export async function approveUrgencyRecovery(args: {
    requestId: string;
    expectedVersion: number;
    previewHash: string;
    idempotencyKey: string;
    audit: AuditContext;
}) {
    try {
        return await withRealtimeOutboxTransaction(await pool.connect(), async (tx) => {
            // A single coherent view of planning, donor promises, quality and supply. Concurrent writes
            // either serialize after this decision or fail this attempt; withdrawal always checks again.
            await tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
            await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`urgency-approval:${args.audit.user_id}:${args.idempotencyKey}`]);
            const payloadHash = createHash('sha256').update(JSON.stringify([args.requestId, args.expectedVersion, args.previewHash])).digest('hex');
            const previous = (await tx.query<{
                id: string;
                request_hash: string;
                response: unknown;
            }>(`SELECT id::text,request_hash,response
      FROM public.delivery_urgency_approvals WHERE created_by=$1 AND request_key=$2::uuid`, [args.audit.user_id, args.idempotencyKey])).rows[0];
            if (previous) {
                if (previous.request_hash !== payloadHash)
                    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Cette clé correspond à une autre approbation.');
                return { approval: previous.response, replayed: true };
            }
            await tx.query('SELECT id FROM public.delivery_urgency_requests WHERE id=$1::uuid FOR UPDATE', [args.requestId]);
            const current = await readUrgencyApprovalTx(tx, args.requestId);
            if (current.request.version !== args.expectedVersion || current.response.preview_hash !== args.previewHash)
                throw new HttpError(409, 'URGENCY_APPROVAL_CHANGED', 'Le dossier, les réservations ou le planning ont changé. Actualisez le contrôle.');
            if (!current.response.can_approve)
                throw new HttpError(409, 'URGENCY_APPROVAL_NOT_READY', 'Corrigez les points signalés avant d’approuver la récupération.', { issues: current.response.issues });
            const approvalId = randomUUID(), response = {
                id: approvalId, request_id: args.requestId, request_version: args.expectedVersion + 1,
                status: 'APPROVED' as const, recoveries: current.response.recoveries, can_withdraw: false as const
            };
            await tx.query(`INSERT INTO public.delivery_urgency_approvals(id,request_id,request_version,preview_hash,planning_revision,
      evidence,response,request_key,request_hash,created_by) VALUES($1::uuid,$2::uuid,$3,$4,$5::bigint,$6::jsonb,$7::jsonb,$8::uuid,$9,$10)`, [approvalId, args.requestId, args.expectedVersion, args.previewHash, current.snapshot.revision,
                JSON.stringify({ control: current.response, recoveries: current.evidence, donor_preview: current.donorPlan.response, planning_basis: current.basis }), JSON.stringify(response),
                args.idempotencyKey, payloadHash, args.audit.user_id]);
            await tx.query(`UPDATE public.delivery_urgency_requests SET status='APPROVED',approved_id=$2::uuid,version=version+1 WHERE id=$1::uuid`, [args.requestId, approvalId]);
            for (const recovery of current.recoveries)
                await preparationAudit(tx, args.audit, recovery.recovery_of_id, 'production.of.urgency-recovery.approve', {
                    request_id: args.requestId, approval_id: approvalId, planning_revision: current.snapshot.revision, quantity: recovery.quantity,
                    finish_before: current.response.recoveries.find(r => r.recovery_id === recovery.id)?.finish_before,
                });
            await repoInsertAuditLog({
                ...args.audit, tx, body: {
                    event_type: 'ACTION', action: 'DELIVERY_URGENCY_APPROVED', entity_type: 'delivery_urgency_request',
                    entity_id: args.requestId, page_key: args.audit.page_key, path: args.audit.path, client_session_id: args.audit.client_session_id, details: response
                }
            });
            await enqueueEntityChanged(tx, {
                entityType: 'COMMANDE_CLIENT', entityId: String(current.donorPlan.context.commande_id),
                module: 'commandes-clients', action: 'updated', at: new Date().toISOString(),
                invalidateKeys: ['livraisons:list', 'production:list', 'planning:list']
            }, { deduplicationKey: `delivery-urgency-approval:${approvalId}` });
            return { approval: response, replayed: false };
        });
    }
    catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (['55P03', '40P01', '40001'].includes(code))
            throw new HttpError(409, 'URGENCY_APPROVAL_BUSY', 'Le planning ou les réservations ont changé pendant le contrôle. Actualisez avant de valider.');
        throw error;
    }
}
