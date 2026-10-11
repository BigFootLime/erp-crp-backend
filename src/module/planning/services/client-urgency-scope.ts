import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type { CentralSimulationInput } from "../validators/planning-central.validators";
import type { CentralSnapshot, ScheduleResult } from "../types/planning-central.types";
type ClientScopedSnapshot = CentralSnapshot & { urgencyClientId?: string };
/** Other clients keep their capacity, including a shared multi-client producer. */
export async function scopeClientUrgency(snapshot: CentralSnapshot, input: CentralSimulationInput, tx: PoolClient): Promise<ClientScopedSnapshot> {
    const requested = new Set(input.changes.map(change => change.taskId));
    const ofIds = snapshot.tasks.filter(task => requested.has(task.id) && task.ofId !== null).map(task => task.ofId!);
    const recoveries = ofIds.length ? (await tx.query<{ client_id: string }>(`SELECT DISTINCT producer.client_id::text AS client_id
      FROM public.ordres_fabrication producer
      JOIN public.delivery_urgency_recoveries recovery ON recovery.recovery_of_id=COALESCE(producer.root_of_id,producer.id)
      JOIN public.delivery_urgency_requests request ON request.id=recovery.request_id
      WHERE producer.id=ANY($1::bigint[]) AND request.status IN ('WAITING_PLANNER','APPROVED')`, [ofIds])).rows : [];
    const recoveryClients = new Set(recoveries.map(row => row.client_id));
    if (recoveryClients.size > 1 || (input.urgency && [...recoveryClients].some(client => client !== input.urgency!.client_id)))
        throw new HttpError(409, 'PLANNING_OTHER_CLIENT_PROTECTED', 'Planifiez séparément les récupérations de clients différents.');
    const client_id = input.urgency?.client_id ?? [...recoveryClients][0];
    if (!client_id) return snapshot;
    if (input.urgency) {
      const evidence = await tx.query(`SELECT e.id FROM public.delivery_promise_events e JOIN public.delivery_promise_roots r ON r.id=e.root_id
    JOIN public.commande_client cc ON cc.id=r.commande_id WHERE e.id=$1::uuid AND cc.client_id=$2`, [input.urgency.promise_event_id, client_id]);
      if (!evidence.rowCount)
        throw new HttpError(422, "PLANNING_URGENCY_EVIDENCE_REQUIRED", "L'urgence doit correspondre à une modification d'engagement de ce client.");
    }
    const shared = (await tx.query<{
        of_id: number;
    }>(`SELECT g.producer_of_id::int AS of_id FROM public.production_consolidations g
    JOIN public.production_consolidation_allocations a ON a.consolidation_id=g.id AND a.state='ACTIVE'
    JOIN public.ordres_fabrication source ON source.id=a.source_of_id
    WHERE g.state='ACTIVE' AND g.producer_of_id=ANY($1::bigint[]) AND source.client_id IS DISTINCT FROM $2`, [snapshot.tasks.flatMap(t => t.ofId ? [t.ofId] : []), client_id])).rows;
    const sharedIds = new Set(shared.map(row => row.of_id));
    const tasks = snapshot.tasks.map(task => task.clientId === client_id && !sharedIds.has(task.ofId ?? 0) ? task : { ...task, locked: true });
    for (const change of input.changes) {
        const task = tasks.find(t => t.id === change.taskId);
        if (!task || task.clientId !== client_id || sharedIds.has(task.ofId ?? 0))
            throw new HttpError(409, "PLANNING_OTHER_CLIENT_PROTECTED", "Cette urgence ne peut déplacer un autre client ou un OF regroupé partagé entre clients.");
    }
    return { ...snapshot, tasks, urgencyClientId: client_id };
}
export function assertUrgencyResult(result: ScheduleResult, snapshot: ClientScopedSnapshot, input: CentralSimulationInput): ScheduleResult {
    const clientId = snapshot.urgencyClientId ?? input.urgency?.client_id;
    if (!clientId)
        return result;
    const own = new Set(snapshot.tasks.filter(t => t.clientId === clientId && !t.locked).map(t => t.id));
    if (result.changes.some(c => !own.has(c.taskId)))
        throw new HttpError(409, "PLANNING_OTHER_CLIENT_PROTECTED", "La simulation déplace une capacité protégée.");
    return { ...result, affected: result.affected.filter(id => own.has(id)),
        forecasts: Object.fromEntries(Object.entries(result.forecasts).filter(([id]) => own.has(id))) };
}
