import type { Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../utils/asyncHandler';
import { HttpError } from '../../../utils/httpError';
import { buildAuditContext } from '../../production/controllers/production.controller';
import { debitStationCutting, scanStationCutting } from '../../production/services/station-cutting.service';
import { executeStationCutting } from '../../production/services/station-cutting-execution.service';
import { materialDebitSchema } from '../../production/validators/of-material.validators';
import { cuttingExecutionCommandSchema } from '../../production/validators/station-cutting.validators';
import { authorizeNativeCuttingTx } from '../repository/terminal-cutting.repository';
import { nativeCuttingWorklist, nativeCuttingScan, nativeCuttingDossier } from '../services/terminal-cutting.service';
import { commandKey, scopeSchema } from '../validators/terminals.validators';
const scope = (req: Request) => scopeSchema.parse({ of_id: req.params.of_id, operation_id: req.params.operation_id });
const audit = (req: Request) => ({ ...buildAuditContext(req), user_id: req.station!.user.id,
    user_role: req.station!.user.role, device_type: 'ANDROID_TERMINAL', page_key: 'terminal.cutting' });
export const worklist = asyncHandler(async (req, res) => {
    const q = z.string().trim().max(120).optional().parse(req.query.q);
    res.json(await nativeCuttingWorklist(req.station!, q));
});
export const resolveOf = asyncHandler(async (req, res) => {
    const b = z.object({ code: z.string().trim().min(1).max(256) }).strict().parse(req.body);
    res.json(await nativeCuttingScan(req.station!, b.code));
});
export const dossier = asyncHandler(async (req, res) => {
    const p = scope(req);
    res.json(await nativeCuttingDossier(req.terminal!, req.station!, p.of_id, p.operation_id));
});
export const scanBar = asyncHandler(async (req, res) => {
    const p = scope(req), b = z.object({ code: z.string().trim().min(1).max(256), eventId: z.string().uuid() }).strict().parse(req.body);
    res.json(await scanStationCutting(req.station!, p.of_id, p.operation_id, b.code, b.eventId));
});
export const debit = asyncHandler(async (req, res) => {
    const p = scope(req), b = materialDebitSchema.parse(req.body);
    if (b.operationId !== p.operation_id || b.idempotencyKey !== commandKey.parse(req.get('Idempotency-Key')))
        throw new HttpError(422, 'TERMINAL_CUTTING_SCOPE', 'Le débit doit correspondre au dossier et à la confirmation ouverts.');
    res.json(await debitStationCutting(req.station!, p.of_id, b, audit(req), tx => authorizeNativeCuttingTx(tx, req.terminal!, req.station!, p.of_id, p.operation_id)));
});
export const execute = asyncHandler(async (req, res) => {
    const p = scope(req), command = cuttingExecutionCommandSchema.parse(req.body);
    res.json(await executeStationCutting({ station: req.station!, ofId: p.of_id, operationId: p.operation_id,
        command, idempotencyKey: commandKey.parse(req.get('Idempotency-Key')), audit: audit(req),
        authorizeTransaction: tx => authorizeNativeCuttingTx(tx, req.terminal!, req.station!, p.of_id, p.operation_id),
    }));
});
