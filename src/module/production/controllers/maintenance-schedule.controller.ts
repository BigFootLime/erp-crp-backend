import type { Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../utils/asyncHandler';
import { HttpError } from '../../../utils/httpError';
import { maintenanceManager } from '../domain/operator-maintenance';
import { buildAuditContext } from './production.controller';
import { maintenanceScheduleProposalSchema, publishMaintenanceScheduleSchema } from '../validators/maintenance-schedule.validators';
import { svcMaintenanceCalendar, svcPreviewMaintenanceCalendar, svcPublishMaintenanceCalendar } from '../services/maintenance-schedule.service';
const canManage = (req: Request) => maintenanceManager([req.user?.role, req.user?.primary_role, ...(req.user?.roles ?? [])]);
function assertManager(req: Request) { if (!canManage(req))
    throw new HttpError(403, 'MAINTENANCE_MANAGER_REQUIRED', 'La publication nécessite un responsable maintenance, la direction ou l’administration.'); }
export const readMaintenanceCalendar = asyncHandler(async (req, res) => { res.json(await svcMaintenanceCalendar(canManage(req))); });
export const previewMaintenanceCalendar = asyncHandler(async (req, res) => {
    assertManager(req);
    const proposal = maintenanceScheduleProposalSchema.parse(req.body);
    res.json(await svcPreviewMaintenanceCalendar(proposal, req.user!.id));
});
export const publishMaintenanceCalendar = asyncHandler(async (req, res) => {
    assertManager(req);
    const body = publishMaintenanceScheduleSchema.parse(req.body);
    const key = z.string().uuid().parse(req.get('Idempotency-Key'));
    res.json(await svcPublishMaintenanceCalendar(body.proposal, body.preview_hash, key, buildAuditContext(req)));
});
