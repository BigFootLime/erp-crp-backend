import { z } from 'zod';
export const subcontractProcurementIdentity = z.object({ ofId: z.coerce.number().int().positive() });
export const subcontractProcurementCommand = z.object({
    idempotencyKey: z.string().uuid(), expectedVersion: z.string().min(1).max(128),
    purchaseId: z.string().uuid(), operationId: z.string().uuid(), catalogueId: z.string().uuid(),
    destinationId: z.string().uuid().nullable(), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'Date inexistante.').nullable(),
    rows: z.array(z.object({ originId: z.string().uuid().nullable(), quantity: z.number().int().positive() }).strict()).min(1).max(2),
    reason: z.string().trim().min(10).max(1000),
}).strict();
export type SubcontractProcurementCommand = z.infer<typeof subcontractProcurementCommand>;

export const subcontractSelection = subcontractProcurementCommand.pick({ purchaseId: true, destinationId: true, due: true })
    .extend({ operationId: z.string().uuid().nullable(), catalogueId: z.string().uuid().nullable() }).strict();
export const subcontractDemandCommand = z.object({
    idempotencyKey: z.string().uuid(), expectedVersion: z.string().min(1).max(128),
    selection: subcontractSelection.optional(),
}).strict();
export type SubcontractSelection = z.infer<typeof subcontractSelection>;
export type SubcontractDemandCommand = z.infer<typeof subcontractDemandCommand>;
