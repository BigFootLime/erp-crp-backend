import { createHash } from 'node:crypto';
import { centralCanonicalJson } from '../../planning/domain/central-canonical-json';
import type { MaintenanceSlot, MaintenanceOccurrence, MaintenanceConflict } from '../types/maintenance-schedule.types';
export const maintenanceSlotKey = (s: MaintenanceSlot) => [s.schedule_id, s.schedule_version, s.machine_id, s.start_ts, s.end_ts].join(':');
export const maintenanceOverlaps = (a: MaintenanceSlot, b: Pick<MaintenanceSlot, 'machine_id' | 'start_ts' | 'end_ts'>) => a.machine_id === b.machine_id && Date.parse(a.start_ts) < Date.parse(b.end_ts) && Date.parse(a.end_ts) > Date.parse(b.start_ts);
/** Preserve actual history, and represent a weekly hour covered by an annual week only once. */
export function reconcileMaintenanceSlots(desired: MaintenanceSlot[], existing: MaintenanceOccurrence[], now: string) {
    const future = desired.filter(s => Date.parse(s.start_ts) > Date.parse(now));
    const active = existing.filter(s => !s.archived && s.status !== 'CANCELLED');
    const preserved = active.filter(s => s.status !== 'PLANNED' || Date.parse(s.start_ts) <= Date.parse(now));
    // A future annual slot being removed must no longer suppress the restored weekly hour.
    const annual = [...desired, ...preserved].filter(s => s.kind === 'LEVEL_2_ANNUAL' && Date.parse(s.end_ts) > Date.parse(now));
    const covered = future.filter(s => s.kind === 'LEVEL_1_WEEKLY' && annual.some(a => a.machine_id === s.machine_id && Date.parse(a.start_ts) <= Date.parse(s.start_ts) && Date.parse(a.end_ts) >= Date.parse(s.end_ts)));
    const coveredKeys = new Set(covered.map(maintenanceSlotKey));
    const required = future.filter(s => !coveredKeys.has(maintenanceSlotKey(s)));
    const mutable = active.filter(s => s.status === 'PLANNED' && Date.parse(s.start_ts) > Date.parse(now));
    const neededKeys = new Set(required.map(maintenanceSlotKey));
    const keptKeys = new Set([...mutable, ...preserved].map(maintenanceSlotKey));
    const cancel = mutable.filter(s => !neededKeys.has(maintenanceSlotKey(s)));
    const create = required.filter(s => !keptKeys.has(maintenanceSlotKey(s)));
    const conflicts: MaintenanceConflict[] = [];
    const ordered = [...required].sort((a, b) => a.machine_id.localeCompare(b.machine_id) || Date.parse(a.start_ts) - Date.parse(b.start_ts));
    for (let i = 0; i < ordered.length; i++)
        for (let j = i + 1; j < ordered.length && ordered[j].machine_id === ordered[i].machine_id && Date.parse(ordered[j].start_ts) < Date.parse(ordered[i].end_ts); j++) {
            if (maintenanceOverlaps(ordered[i], ordered[j]))
                conflicts.push({ machine_id: ordered[i].machine_id, start_ts: ordered[i].start_ts, end_ts: ordered[i].end_ts, title: ordered[j].title, event_id: null, reason: 'Deux règles de maintenance se chevauchent.' });
        }
    for (const s of create) {
        if (!s.local_valid)
            conflicts.push({ machine_id: s.machine_id, start_ts: s.start_ts, end_ts: s.end_ts, title: s.title, event_id: null, reason: 'L’heure choisie est inexistante ou ambiguë au changement d’heure. Choisissez un autre horaire.' });
    }
    return { create, cancel, preserved, covered, conflicts, unchanged: mutable.length - cancel.length };
}
export function maintenancePreviewHash(input: unknown) { return createHash('sha256').update(centralCanonicalJson(input)).digest('hex'); }
