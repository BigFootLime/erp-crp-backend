import { z } from "zod";
const instant = z.string().datetime({ offset: true });
export const centralWindowSchema = z.object({
  from: instant, to: instant, cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(250),
  of_id: z.coerce.number().int().positive().optional(), search: z.string().trim().max(100).optional(),
  resource_id: z.string().max(100).optional(),
}).refine(q => Date.parse(q.to) > Date.parse(q.from) && Date.parse(q.to) - Date.parse(q.from) <= 367 * 86400000,
  { message: "La fenêtre doit couvrir entre un instant et douze mois." });
export const centralSimulationSchema = z.object({
  revision: z.string().regex(/^\d+$/), from: instant, to: instant,
  changes: z.array(z.object({ taskId: z.string().min(1).max(100), expectedVersion: z.string().min(1).max(200),
    earliestStart: instant, resourceIds: z.array(z.string().min(1).max(100)).min(1).max(4).optional(), autoAssign: z.boolean().optional()
  }).refine(change => !change.autoAssign || !change.resourceIds, { message: "Choisissez une affectation automatique ou une ressource explicite." })).min(1).max(100),
}).refine(q => Date.parse(q.to) > Date.parse(q.from) && Date.parse(q.to) - Date.parse(q.from) <= 367 * 86400000,
  { message: "Fenêtre de simulation invalide." })
  .refine(q => new Set(q.changes.map(c => c.taskId)).size === q.changes.length, { message: "Une opération ne peut être déplacée deux fois." });
export const centralApplySchema = z.object({ revision: z.string().regex(/^\d+$/) });
export const centralUnplanSchema = z.object({
  revision: z.string().regex(/^\d+$/), from: instant, to: instant,
  tasks: z.array(z.object({ id: z.string().min(1).max(100), expectedVersion: z.string().min(1).max(200) })).min(1).max(100),
}).refine(q => Date.parse(q.to) > Date.parse(q.from) && Date.parse(q.to)-Date.parse(q.from) <= 367*86400000,
  { message: "Fenêtre de déplanification invalide." })
  .refine(q => new Set(q.tasks.map(t => t.id)).size === q.tasks.length, { message: "Une opération ne peut être retirée deux fois." });
export type CentralUnplanInput = z.infer<typeof centralUnplanSchema>;
export const centralTaskConfigSchema = z.object({
  expectedVersion: z.string().min(1).max(200),
  envelopeMinutes: z.number().min(0).max(1000000).nullable().optional(),
  earliestStart: instant.nullable().optional(), locked: z.boolean().optional(),
  blockers: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  configurationKey: z.string().max(160).optional(),
});
export type CentralWindow = z.infer<typeof centralWindowSchema>;
export type CentralSimulationInput = z.infer<typeof centralSimulationSchema>;
