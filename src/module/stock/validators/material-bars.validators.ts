import { z } from 'zod';

const mm = z.number().finite().nonnegative().max(1e9).multipleOf(.001);
export const receivedMaterialBarsSchema = z.array(z.object({ lengthMm: mm.positive(), count: z.number().int().positive().max(1000) }).strict())
  .min(1).max(1000).refine(groups => groups.reduce((n, group) => n + group.count, 0) <= 1000, '1 000 barres maximum par entrée.');
export const materialBarBatchParams = z.object({ batchId: z.string().uuid() }).strict();
export const materialBarInventoryCommand = z.object({
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
  bars: z.array(z.object({
    id: z.string().uuid(),
    lengthMm: mm.positive(),
    depreciatedMm: mm.optional(),
    allocations: z.array(z.object({ reservationId: z.string().uuid(), quantityMm: mm.positive() }).strict()).max(500),
  }).strict()).max(1000),
}).strict().superRefine((body, ctx) => {
  if (new Set(body.bars.map(bar => bar.id)).size !== body.bars.length)
    ctx.addIssue({ code: 'custom', path: ['bars'], message: 'Une barre ne peut figurer qu’une fois.' });
  body.bars.forEach((bar, index) => {
    if (new Set(bar.allocations.map(a => a.reservationId)).size !== bar.allocations.length)
      ctx.addIssue({ code: 'custom', path: ['bars', index, 'allocations'], message: 'Une réservation ne peut figurer qu’une fois par barre.' });
  });
});
export type MaterialBarInventoryCommand = z.infer<typeof materialBarInventoryCommand>;
