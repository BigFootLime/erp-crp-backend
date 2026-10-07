import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withPlanningCommand } from '../../planning/repository/planning-command.repository';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import type { AuditContext } from './production.repository';
import { archiveMachineUnavailabilityTx, createMachineUnavailabilityTx } from './machine-park.repository';
import { readMaintenanceSchedules, readMaintenanceOccurrences, readMaintenanceReferences, expandMaintenanceSlots } from './maintenance-schedule-read.repository';
import { maintenanceOverlaps, maintenancePreviewHash, reconcileMaintenanceSlots } from '../domain/maintenance-schedule';
import type { MaintenanceScheduleProposal } from '../validators/maintenance-schedule.validators';
import type { MaintenanceSchedule, MaintenanceSchedulePreview, MaintenanceSlot } from '../types/maintenance-schedule.types';
const stale = () => new HttpError(409, 'MAINTENANCE_PREVIEW_STALE', 'Le planning ou la règle a changé. Actualisez l’aperçu avant de publier.');
function draftId(proposal: MaintenanceScheduleProposal, actor: number) {
    const hash = maintenancePreviewHash({ proposal, actor });
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function proposedRules(rules: MaintenanceSchedule[], proposal: MaintenanceScheduleProposal, actor: number, today: string) {
    const current = proposal.schedule_id ? rules.find(s => s.id === proposal.schedule_id) : null;
    if (proposal.schedule_id && (!current || current.version !== proposal.expected_version))
        throw stale();
    if (current && proposal.definition && current.kind !== proposal.definition.kind)
        throw new HttpError(422, 'MAINTENANCE_KIND_IMMUTABLE', 'Une règle hebdomadaire ne peut pas devenir annuelle. Créez une autre règle.');
    const definition = proposal.definition ?? current!.definition;
    if (!current) {
        const earliest = definition.kind === 'LEVEL_1_WEEKLY' ? definition.start_date : definition.entries.reduce((min, t) => t.start_date < min ? t.start_date : min, '9999-12-31');
        if (earliest < today)
            throw new HttpError(422, 'MAINTENANCE_PAST_START', 'Une nouvelle règle doit commencer aujourd’hui ou plus tard.');
    }
    const next: MaintenanceSchedule = { id: current?.id ?? draftId(proposal, actor), kind: definition.kind, version: (current?.version ?? 0) + 1, enabled: proposal.definition !== null, definition, reason: proposal.reason, updated_at: '' };
    if (!current && rules.some(s => s.id === next.id))
        throw new HttpError(409, 'MAINTENANCE_SCHEDULE_EXISTS', 'Cette règle a déjà été publiée. Ouvrez-la pour la modifier.');
    const all = [...rules.filter(s => s.id !== next.id), next];
    if (all.filter(r => r.enabled).length > 100)
        throw new HttpError(413, 'MAINTENANCE_SCHEDULE_LIMIT', '100 règles actives au maximum. Désactivez une règle devenue inutile.');
    const annualMachines = new Set<string>();
    for (const rule of all.filter(r => r.enabled)) {
        const annual = rule.definition;
        if (annual.kind !== 'LEVEL_2_ANNUAL') continue;
        for (const entry of annual.entries) {
            const key = `${annual.year}:${entry.machine_id}`;
            if (annualMachines.has(key)) throw new HttpError(422, 'MAINTENANCE_ANNUAL_DUPLICATE', 'Une machine dispose déjà d’une semaine annuelle pour cette année. Modifiez la règle existante.', { machine_id: entry.machine_id, year: annual.year });
            annualMachines.add(key);
        }
    }
    return { all, next, current };
}
function assertSlotReferences(slots: MaintenanceSlot[], refs: Awaited<ReturnType<typeof readMaintenanceReferences>>) {
    for (const slot of slots) {
        const machine = refs.machines.find(m => m.id === slot.machine_id);
        if (!machine || machine.status !== 'ACTIVE' || !machine.scheduling_enabled)
            throw new HttpError(422, 'MAINTENANCE_MACHINE_INACTIVE', 'Une machine choisie est archivée, inactive ou exclue du planning.', { machine_id: slot.machine_id });
        if (slot.provider_id && !refs.providers.some(p => p.id === slot.provider_id))
            throw new HttpError(422, 'MAINTENANCE_PROVIDER_INACTIVE', 'Choisissez un fournisseur actif comme prestataire externe.');
        if (slot.responsible_user_id && !refs.users.some(u => u.id === slot.responsible_user_id))
            throw new HttpError(422, 'MAINTENANCE_OPERATOR_INACTIVE', 'Choisissez un intervenant interne actif.');
        if (slot.maintenance_plan_id && !refs.plans.some(p => p.id === slot.maintenance_plan_id && p.machine_id === slot.machine_id))
            throw new HttpError(422, 'MAINTENANCE_PLAN_INVALID', 'Le plan actif doit appartenir à la machine choisie.');
    }
}
async function buildPreviewTx(tx: PoolClient, proposal: MaintenanceScheduleProposal, actor: number, lock: boolean) {
    const clock = (await tx.query<{
        revision: string;
        now: string;
        today: string;
    }>(`SELECT revision::text,clock_timestamp()::text AS now,
  (clock_timestamp() AT TIME ZONE 'Europe/Paris')::date::text AS today FROM public.planning_central_settings WHERE singleton ${lock ? 'FOR UPDATE' : ''}`)).rows[0];
    if (!clock)
        throw new HttpError(503, 'MAINTENANCE_PLANNING_UNCONFIGURED', 'Le référentiel du planning n’est pas installé.');
    const rules = await readMaintenanceSchedules(tx, lock);
    const { all, next, current } = proposedRules(rules, proposal, actor, clock.today);
    const desired = await expandMaintenanceSlots(tx, all);
    const refs = await readMaintenanceReferences(tx);
    // Validate the actual requested definition too, even if its selected dates produce no future slot.
    const requested = next.enabled ? await expandMaintenanceSlots(tx, [next]) : [];
    assertSlotReferences(requested, refs);
    let existing = await readMaintenanceOccurrences(tx);
    if (lock) {
        const ids = [...new Set([...desired, ...existing].map(s => s.machine_id))].sort();
        if (ids.length)
            await tx.query('SELECT id FROM public.machines WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
        existing = await readMaintenanceOccurrences(tx, true);
    }
    const reconciled = reconcileMaintenanceSlots(desired, existing, clock.now);
    assertSlotReferences(reconciled.create, refs);
    if (!current && !requested.some(s => Date.parse(s.start_ts) > Date.parse(clock.now)))
        throw new HttpError(422, 'MAINTENANCE_NO_FUTURE_SLOT', 'La période ne contient aucun créneau futur. Choisissez une date et une heure à venir.');
    const { create, cancel, preserved, covered, conflicts, unchanged } = reconciled;
    if (create.length) {
        const machineIds = [...new Set(create.map(s => s.machine_id))].sort();
        const from = new Date(Math.min(...create.map(s => Date.parse(s.start_ts)))).toISOString();
        const to = new Date(Math.max(...create.map(s => Date.parse(s.end_ts)))).toISOString();
        const events = await tx.query<{
            id: string;
            machine_id: string;
            title: string;
            start_ts: string;
            end_ts: string;
        }>(`SELECT e.id::text,
   COALESCE(e.machine_id,p.machine_id)::text AS machine_id,e.title,e.start_ts::text,e.end_ts::text
   FROM public.planning_events e LEFT JOIN public.postes p ON p.id=e.poste_id
   WHERE COALESCE(e.machine_id,p.machine_id)=ANY($1::uuid[]) AND e.archived_at IS NULL AND e.status<>'CANCELLED'
   AND e.start_ts<$3::timestamptz AND e.end_ts>$2::timestamptz AND NOT e.id=ANY($4::uuid[]) ORDER BY e.start_ts,e.id`, [machineIds, from, to, cancel.map(s => s.planning_event_id)]);
        for (const slot of create)
            for (const event of events.rows)
                if (maintenanceOverlaps(slot, event))
                    conflicts.push({ machine_id: slot.machine_id, start_ts: slot.start_ts, end_ts: slot.end_ts, title: event.title, event_id: event.id, reason: 'Un événement existant occupe cette machine. Déplacez-le explicitement ou modifiez la maintenance.' });
    }
    const warnings: string[] = [];
    if (covered.length)
        warnings.push(`${covered.length} créneau(x) hebdomadaire(s) sont couverts par une semaine annuelle : ils ne seront pas réservés une seconde fois.`);
    if (preserved.length)
        warnings.push(`${preserved.length} créneau(x) commencé(s) ou terminé(s) encore lié(s) au planning restent conservés. Tout l’historique passé reste conservé.`);
    if (create.some(s => !s.maintenance_plan_id))
        warnings.push('Des créneaux ne sont pas associés à un plan de contrôle. Définissez les checklists et habilitations dans la fiche machine avant leur exécution.');
    if (create.some(s => s.execution_mode === 'INTERNAL' && !s.responsible_user_id))
        warnings.push('Des intervenants internes restent à affecter. Les créneaux réservent les machines ; ils ne constituent pas une habilitation d’opérateur.');
    const preview_hash = maintenancePreviewHash({ proposal, revision: clock.revision, create, cancel: cancel.map(s => ({ id: s.id, event: s.planning_event_id, start: s.start_ts, end: s.end_ts, status: s.status })), preserved: preserved.map(s => ({ id: s.id, event: s.planning_event_id, status: s.status, start: s.start_ts, end: s.end_ts })), covered, conflicts });
    const preview: MaintenanceSchedulePreview = { proposal, revision: clock.revision, preview_hash, can_publish: conflicts.length === 0, create, cancel, preserved, unchanged, covered, conflicts, warnings, now: new Date(clock.now).toISOString() };
    return { preview, next, current, refs };
}
export async function repoPreviewMaintenanceSchedule(proposal: MaintenanceScheduleProposal, actor: number) {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const { preview } = await buildPreviewTx(tx, proposal, actor, false);
        await tx.query('COMMIT');
        return preview;
    }
    catch (error) {
        await tx.query('ROLLBACK');
        throw error;
    }
    finally {
        tx.release();
    }
}
export async function repoPublishMaintenanceSchedule(proposal: MaintenanceScheduleProposal, hash: string, key: string, audit: AuditContext) {
    try {
        return await withPlanningCommand(audit, key, 'maintenance-schedule.publish', { proposal, hash }, async (tx) => {
            const { preview, next, current } = await buildPreviewTx(tx, proposal, audit.user_id!, true);
            if (hash !== preview.preview_hash)
                throw stale();
            if (!preview.can_publish)
                throw new HttpError(409, 'MAINTENANCE_SCHEDULE_CONFLICT', 'Résolvez les conflits avant de publier.');
            // Lock selected external/internal references until commit; reject archival/profile changes after preview.
            const providerIds = [...new Set(preview.create.flatMap(s => s.provider_id ? [s.provider_id] : []))].sort();
            const userIds = [...new Set(preview.create.flatMap(s => s.responsible_user_id ? [s.responsible_user_id] : []))].sort();
            const planIds = [...new Set(preview.create.flatMap(s => s.maintenance_plan_id ? [s.maintenance_plan_id] : []))].sort();
            if (providerIds.length)
                await tx.query('SELECT id FROM public.fournisseurs WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [providerIds]);
            if (userIds.length)
                await tx.query('SELECT id FROM public.users WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE', [userIds]);
            if (planIds.length)
                await tx.query('SELECT id FROM public.production_machine_maintenance_plans WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [planIds]);
            const refs = await readMaintenanceReferences(tx);
            assertSlotReferences(preview.create, refs);
            if (current)
                await tx.query('UPDATE public.production_maintenance_schedules SET version=$2,enabled=$3,updated_by=$4,updated_at=clock_timestamp() WHERE id=$1::uuid', [next.id, next.version, next.enabled, audit.user_id]);
            else
                await tx.query('INSERT INTO public.production_maintenance_schedules(id,kind,version,enabled,created_by,updated_by) VALUES($1::uuid,$2,$3,$4,$5,$5)', [next.id, next.kind, next.version, next.enabled, audit.user_id]);
            await tx.query('INSERT INTO public.production_maintenance_schedule_revisions(schedule_id,version,enabled,definition,reason,created_by) VALUES($1::uuid,$2,$3,$4::jsonb,$5,$6)', [next.id, next.version, next.enabled, JSON.stringify(next.definition), proposal.reason, audit.user_id]);
            for (const old of preview.cancel) {
                if (Date.parse(old.start_ts) <= Date.now())
                    throw stale();
                await archiveMachineUnavailabilityTx(tx, { machineId: old.machine_id, unavailabilityId: old.unavailability_id, audit });
                await tx.query(`INSERT INTO public.production_machine_maintenance_events(machine_id,maintenance_plan_id,event_type,planning_event_id,unavailability_id,notes,created_by)
    VALUES($1::uuid,$2::uuid,'CANCELLED',$3::uuid,$4::uuid,$5,$6)`, [old.machine_id, old.maintenance_plan_id, old.planning_event_id, old.unavailability_id, proposal.reason, audit.user_id]);
            }
            for (const slot of preview.create) {
                if (Date.parse(slot.start_ts) <= Date.now())
                    throw stale();
                const provider = refs.providers.find(p => p.id === slot.provider_id);
                const user = refs.users.find(u => u.id === slot.responsible_user_id);
                const plan = refs.plans.find(p => p.id === slot.maintenance_plan_id);
                const snapshot = { ...slot, timezone: 'Europe/Paris', provider: provider ?? null, intervenant: user ?? null, plan: plan ?? null };
                const who = slot.execution_mode === 'EXTERNAL' ? `Prestataire : ${provider!.nom}` : user ? `Interne : ${user.name || user.username}` : 'Interne — fraiseur / tourneur à affecter';
                const comment = [slot.title, who, slot.notes].filter(Boolean).join('\n');
                const unavailabilityId = await createMachineUnavailabilityTx(tx, { machineId: slot.machine_id, audit, body: { cause: 'PREVENTIVE_MAINTENANCE', source: 'maintenance_schedule', start_ts: slot.start_ts, end_ts: slot.end_ts, maintenance_plan_id: slot.maintenance_plan_id, comment } });
                const eventId = (await tx.query<{
                    planning_event_id: string;
                }>('SELECT planning_event_id::text FROM public.production_machine_unavailability WHERE id=$1::uuid', [unavailabilityId])).rows[0].planning_event_id;
                await tx.query('UPDATE public.planning_events SET title=$2,description=$3,updated_by=$4 WHERE id=$1::uuid', [eventId, `${slot.kind === 'LEVEL_1_WEEKLY' ? 'Niveau 1' : 'Niveau 2'} — ${slot.title}`, comment, audit.user_id]);
                await tx.query(`INSERT INTO public.production_maintenance_schedule_occurrences(schedule_id,schedule_version,unavailability_id,machine_id,start_ts,end_ts,provider_id,responsible_user_id,snapshot,created_by)
    VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::timestamptz,$6::timestamptz,$7::uuid,$8,$9::jsonb,$10)`, [slot.schedule_id, slot.schedule_version, unavailabilityId, slot.machine_id, slot.start_ts, slot.end_ts, slot.provider_id, slot.responsible_user_id, JSON.stringify(snapshot), audit.user_id]);
                await tx.query(`INSERT INTO public.production_machine_maintenance_events(machine_id,maintenance_plan_id,event_type,due_at,planning_event_id,unavailability_id,notes,created_by)
    VALUES($1::uuid,$2::uuid,'SCHEDULED',$3::timestamptz,$4::uuid,$5::uuid,$6,$7)`, [slot.machine_id, slot.maintenance_plan_id, slot.start_ts, eventId, unavailabilityId, comment, audit.user_id]);
            }
            const revision = (await tx.query<{
                revision: string;
            }>('SELECT revision::text FROM public.planning_central_settings WHERE singleton')).rows[0].revision;
            const response = { schedule_id: next.id, version: next.version, enabled: next.enabled, revision, created: preview.create.length, cancelled: preview.cancel.length, preserved: preview.preserved.length, covered: preview.covered.length };
            await repoInsertAuditLog({ user_id: audit.user_id, tx, ip: audit.ip, user_agent: audit.user_agent, device_type: audit.device_type, os: audit.os, browser: audit.browser,
                body: { event_type: 'ACTION', action: 'production.maintenance.schedule.publish', page_key: audit.page_key, entity_type: 'production_maintenance_schedules', entity_id: next.id, path: audit.path, client_session_id: audit.client_session_id, details: { ...response, reason: proposal.reason, preview_hash: hash } } });
            return response;
        });
    }
    catch (error) {
        if ((error as {
            code?: string;
        }).code === '23P01')
            throw new HttpError(409, 'MAINTENANCE_SCHEDULE_CONFLICT', 'Un événement a occupé la machine pendant la publication. Actualisez l’aperçu.');
        if (['40P01', '40001'].includes((error as {
            code?: string;
        }).code ?? ''))
            throw stale();
        throw error;
    }
}
