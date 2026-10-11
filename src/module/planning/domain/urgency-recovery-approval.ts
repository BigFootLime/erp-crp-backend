import type { CentralTask, CentralSnapshot } from '../types/planning-central.types';
import { schedule } from './central-scheduler';
import { dependencyClosure } from './central-dependencies';
export type UrgencyApprovalIssue = {
    code: string;
    message: string;
    of_id?: number;
    task_id?: string;
};
export type UrgencyRecoveryEvidence = {
    recovery_id: string;
    of_id: number;
    of_ids: number[];
    quantity: string;
    protected_before: string;
    current_protected_before: string | null;
    dossier_complete: boolean;
    identity_matches: boolean;
    operation_ids: string[];
};
const time = (value: string) => Date.parse(value);
const validInterval = (task: CentralTask) => !!task.committed && Number.isFinite(time(task.committed.start))
    && Number.isFinite(time(task.committed.end)) && time(task.committed.end) > time(task.committed.start);
/** Check complete reserved intervals, including buffers the duration calculation may shorten. */
function overlappingCommitments(snapshot: CentralSnapshot, selected: Set<string>): Set<string> {
    const capacities = new Map(snapshot.resources.map(resource => [resource.id, resource.capacityId ?? resource.id]));
    const byCapacity = new Map<string, CentralTask[]>();
    for (const task of snapshot.tasks) {
        if (task.external || !validInterval(task))
            continue;
        for (const capacity of new Set(task.resourceIds.map(id => capacities.get(id) ?? id))) {
            if (!byCapacity.has(capacity))
                byCapacity.set(capacity, []);
            byCapacity.get(capacity)!.push(task);
        }
    }
    const conflicts = new Set<string>();
    for (const tasks of byCapacity.values()) {
        tasks.sort((a, b) => time(a.committed!.start) - time(b.committed!.start));
        let furthestEnd = -Infinity, selectedEnd = -Infinity, selectedId = '';
        for (const task of tasks) {
            const start = time(task.committed!.start), end = time(task.committed!.end);
            if (selected.has(task.id) && start < furthestEnd)
                conflicts.add(task.id);
            if (start < selectedEnd)
                conflicts.add(selectedId);
            if (selected.has(task.id) && end > selectedEnd) {
                selectedEnd = end;
                selectedId = task.id;
            }
            furthestEnd = Math.max(furthestEnd, end);
        }
    }
    return conflicts;
}
/** Verify existing commitments with the canonical scheduler. Never apply its proposed changes. */
export function evaluateUrgencyRecoveryApproval(input: {
    recoveries: UrgencyRecoveryEvidence[];
    snapshot: CentralSnapshot;
    now: string;
}) {
    const issues: UrgencyApprovalIssue[] = [], { snapshot, recoveries } = input;
    const ofIds = new Set(recoveries.flatMap(r => r.of_ids));
    const selected = snapshot.tasks.filter(task => task.ofId !== null && ofIds.has(task.ofId));
    const byId = new Map(snapshot.tasks.map(task => [task.id, task]));
    const issue = (code: string, message: string, of_id?: number, task_id?: string) => issues.push({ code, message, of_id, task_id });
    if (!recoveries.length)
        issue('RECOVERY_MISSING', 'Aucun OF de récupération n’est rattaché à cette demande.');
    if (snapshot.nextCursor)
        issue('PLANNING_INCOMPLETE', 'Le contrôle dépasse la capacité de lecture du planning. Réduisez la demande urgente.');
    if (!['COMMIT', 'EXECUTE', 'LEARN'].includes(snapshot.activation))
        issue('PLANNING_NOT_COMMITTABLE', 'Activez la validation du planning avant d’approuver une récupération.');
    for (const recovery of recoveries) {
        if (!recovery.identity_matches)
            issue('RECOVERY_DEFINITION_CHANGED', 'La commande, la pièce ou la quantité de récupération a changé.', recovery.of_id);
        if (!recovery.dossier_complete)
            issue('RECOVERY_DOSSIER_INCOMPLETE', 'Complétez le dossier de récupération et celui de ses sous-pièces.', recovery.of_id);
        if (!recovery.current_protected_before)
            issue('DONOR_PROMISE_MISSING', 'L’affaire donneuse n’a plus d’engagement actif.', recovery.of_id);
        const tasks = recovery.operation_ids.map(id => byId.get(`op:${id}`));
        if (!tasks.length || tasks.some(task => !task))
            issue('RECOVERY_OPERATIONS_MISSING', 'Les opérations de récupération ne sont pas toutes présentes dans le planning.', recovery.of_id);
        const deadline = Math.min(time(recovery.protected_before), time(recovery.current_protected_before ?? recovery.protected_before));
        for (const task of tasks) {
            if (!task)
                continue;
            if (task.readiness !== 'READY' || task.source !== 'OPERATION')
                issue('RECOVERY_NOT_READY', 'Validez la définition technique de cette opération.', task.ofId ?? undefined, task.id);
            if (!validInterval(task) || task.commitment !== 'COMMITTED' || task.actual)
                issue('RECOVERY_NOT_PLANNED', 'Engagez les créneaux de toutes les opérations de récupération avant l’approbation.', task.ofId ?? undefined, task.id);
            else {
                if (time(task.committed!.start) < time(input.now))
                    issue('RECOVERY_PLAN_OVERDUE', 'Un créneau prévu est déjà passé : actualisez le planning.', task.ofId ?? undefined, task.id);
                if (!Number.isFinite(deadline) || time(task.committed!.end) >= deadline)
                    issue('RECOVERY_TOO_LATE', 'La récupération doit finir avant le jour de livraison de l’affaire donneuse.', task.ofId ?? undefined, task.id);
            }
        }
    }
    if (!snapshot.coverageAvailable)
        issue('MATERIAL_COVERAGE_UNAVAILABLE', 'Le contrôle des approvisionnements doit être disponible.');
    for (const demand of snapshot.demands.filter(d => d.coverage && ofIds.has(d.coverage.ofId))) {
        const coverage = demand.coverage!;
        const operation = selected.find(t => t.operationId === coverage.operationId);
        if (!operation?.committed || coverage.unsecured > 0 || coverage.reservedBlocked > 0 || coverage.receivedBlocked > 0 || coverage.issues.length
            || !coverage.availableAt || time(coverage.availableAt) > time(operation.committed.start))
            issue('RECOVERY_SUPPLY_UNSECURED', `${coverage.label} : confirmez une couverture utilisable avant l’opération.`, coverage.ofId, operation?.id);
    }
    // Dependencies outside the recovery remain fixed, with their real commitments/actual completion.
    // Forecast-only predecessors are not a firm promise on which borrowing can rely.
    const closure = dependencyClosure(snapshot.dependencies, selected.map(t => t.id), 'upstream');
    for (const id of closure) {
        const task = byId.get(id);
        if (!task) {
            issue('RECOVERY_DEPENDENCY_MISSING', 'Un prérequis est absent du contrôle de planning.', undefined, id);
            continue;
        }
        if (!ofIds.has(task.ofId ?? -1) && !(task.commitment === 'DONE' && task.actual?.end) && !task.committed)
            issue('RECOVERY_DEPENDENCY_UNCOMMITTED', 'Un prérequis de programmation ou de production attend encore sa planification.', task.ofId ?? undefined, id);
    }
    for (const id of overlappingCommitments(snapshot, new Set(selected.map(t => t.id))))
        issue('RECOVERY_CAPACITY_OVERLAP', 'Un créneau de récupération chevauche une autre réservation de capacité.', byId.get(id)?.ofId ?? undefined, id);
    const resourcesById = new Map(snapshot.resources.map(resource => [resource.id, resource]));
    for (const task of selected)
        if (!task.external && task.resourceIds.some(id => resourcesById.get(id)?.capacityEnabled === false))
            issue('RECOVERY_RESOURCE_UNAVAILABLE', 'Une ressource est indisponible pour cette récupération.', task.ofId ?? undefined, task.id);
    const requests = selected.filter(t => t.source === 'OPERATION' && validInterval(t) && t.commitment === 'COMMITTED' && !t.actual)
        .map(task => ({ taskId: task.id, earliestStart: task.committed!.start, resourceIds: task.resourceIds }));
    if (requests.length) {
        const requested = new Set(requests.map(r => r.taskId));
        const tasks: CentralTask[] = snapshot.tasks.map(task => ({ ...task, locked: requested.has(task.id) ? false : true }));
        const result = schedule({ tasks, resources: snapshot.resources, dependencies: snapshot.dependencies, from: input.now, requested: requests });
        for (const conflict of result.conflicts)
            if (conflict.blocking !== false)
                issue('RECOVERY_PLANNING_CONFLICT', conflict.message, byId.get(conflict.taskId)?.ofId ?? undefined, conflict.taskId);
        for (const request of requests) {
            const task = byId.get(request.taskId)!, calculated = result.forecasts[task.id];
            if (!calculated || time(calculated.start) !== time(task.committed!.start) || time(calculated.end) > time(task.committed!.end))
                issue('RECOVERY_REPLAN_REQUIRED', 'Le créneau engagé ne couvre plus la charge réalisable. Replanifiez cette opération.', task.ofId ?? undefined, task.id);
        }
        for (const change of result.changes)
            if (!requested.has(change.taskId))
                issue('RECOVERY_OTHER_COMMITMENT', 'La récupération nécessite une modification d’un autre engagement.', byId.get(change.taskId)?.ofId ?? undefined, change.taskId);
    }
    return {
        can_approve: issues.length === 0, issues, recoveries: recoveries.map(recovery => ({
            recovery_id: recovery.recovery_id, of_id: recovery.of_id, quantity: recovery.quantity,
            finish_before: Number.isFinite(Math.min(time(recovery.protected_before), time(recovery.current_protected_before ?? recovery.protected_before)))
                ? new Date(Math.min(time(recovery.protected_before), time(recovery.current_protected_before ?? recovery.protected_before))).toISOString() : null,
            planned_finish: snapshot.tasks.filter(t => t.ofId !== null && recovery.of_ids.includes(t.ofId) && t.committed)
                .map(t => t.committed!.end).sort((a, b) => time(a) - time(b)).at(-1) ?? null,
        }))
    };
}
