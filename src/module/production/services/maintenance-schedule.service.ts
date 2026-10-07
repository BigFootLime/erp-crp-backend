import type { AuditContext } from '../repository/production.repository';
import type { MaintenanceScheduleProposal } from '../validators/maintenance-schedule.validators';
import { readMaintenanceCalendarWorkspace } from '../repository/maintenance-schedule-read.repository';
import { repoPreviewMaintenanceSchedule, repoPublishMaintenanceSchedule } from '../repository/maintenance-schedule.repository';
export const svcMaintenanceCalendar = (canManage: boolean) => readMaintenanceCalendarWorkspace(canManage);
export const svcPreviewMaintenanceCalendar = (proposal: MaintenanceScheduleProposal, actor: number) => repoPreviewMaintenanceSchedule(proposal, actor);
export const svcPublishMaintenanceCalendar = (proposal: MaintenanceScheduleProposal, hash: string, key: string, audit: AuditContext) => repoPublishMaintenanceSchedule(proposal, hash, key, audit);
