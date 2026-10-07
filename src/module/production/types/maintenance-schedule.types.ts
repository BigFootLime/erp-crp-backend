import type { MaintenanceScheduleDefinition, MaintenanceScheduleProposal } from '../validators/maintenance-schedule.validators';
export type MaintenanceSchedule = {
    id: string;
    kind: MaintenanceScheduleDefinition['kind'];
    version: number;
    enabled: boolean;
    definition: MaintenanceScheduleDefinition;
    reason: string;
    updated_at: string;
};
export type MaintenanceSlot = {
    schedule_id: string;
    schedule_version: number;
    kind: MaintenanceScheduleDefinition['kind'];
    title: string;
    notes: string;
    machine_id: string;
    start_ts: string;
    end_ts: string;
    local_valid: boolean;
    execution_mode: 'INTERNAL' | 'EXTERNAL';
    provider_id: string | null;
    responsible_user_id: number | null;
    maintenance_plan_id: string | null;
};
export type MaintenanceOccurrence = MaintenanceSlot & {
    id: string;
    unavailability_id: string;
    planning_event_id: string;
    status: string;
    archived: boolean;
    snapshot: Record<string, unknown>;
};
export type MaintenanceConflict = {
    machine_id: string;
    start_ts: string;
    end_ts: string;
    title: string;
    event_id: string | null;
    reason: string;
};
export type MaintenanceSchedulePreview = {
    proposal: MaintenanceScheduleProposal;
    revision: string;
    preview_hash: string;
    can_publish: boolean;
    create: MaintenanceSlot[];
    cancel: MaintenanceOccurrence[];
    preserved: MaintenanceOccurrence[];
    unchanged: number;
    covered: MaintenanceSlot[];
    conflicts: MaintenanceConflict[];
    warnings: string[];
    now: string;
};
