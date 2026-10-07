import { z } from 'zod';
const uuid = z.string().uuid().transform(v => v.toLowerCase());
const date = z.string().date();
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Saisissez une heure entre 00:00 et 23:59.');
const target = z.object({
    machine_id: uuid,
    maintenance_plan_id: uuid.nullable().default(null),
    responsible_user_id: z.number().int().positive().nullable().default(null),
}).strict();
const base = { title: z.string().trim().min(3).max(240), notes: z.string().trim().max(2000).default('') };
const weekly = z.object({
    ...base, kind: z.literal('LEVEL_1_WEEKLY'), start_date: date, end_date: date,
    weekday: z.number().int().min(1).max(7).default(4), start_time: time,
    duration_minutes: z.number().int().min(1).max(480).default(60),
    targets: z.array(target).min(1).max(100),
}).strict();
const annual = z.object({
    ...base, kind: z.literal('LEVEL_2_ANNUAL'), year: z.number().int().min(2026).max(2100),
    entries: z.array(target.extend({
        start_date: date, start_time: time, execution_mode: z.enum(['INTERNAL', 'EXTERNAL']), provider_id: uuid.nullable().default(null),
    }).strict()).min(1).max(100),
}).strict();
export const maintenanceScheduleDefinitionSchema = z.discriminatedUnion('kind', [weekly, annual]).superRefine((v, ctx) => {
    const targets = v.kind === 'LEVEL_1_WEEKLY' ? v.targets : v.entries;
    if (new Set(targets.map(t => t.machine_id)).size !== targets.length)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [v.kind === 'LEVEL_1_WEEKLY' ? 'targets' : 'entries'], message: 'Une machine ne peut apparaître qu’une fois dans cette règle.' });
    if (v.kind === 'LEVEL_1_WEEKLY') {
        const days = (Date.parse(v.end_date) - Date.parse(v.start_date)) / 86400000;
        if (days < 0 || days > 365)
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end_date'], message: 'La période doit être comprise entre 1 et 366 jours. Prolongez-la ensuite explicitement.' });
    }
    else
        v.entries.forEach((t, index) => {
            if (Number(t.start_date.slice(0, 4)) !== v.year)
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'start_date'], message: 'La semaine doit commencer dans l’année choisie.' });
            if (t.execution_mode === 'EXTERNAL' && !t.provider_id)
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'provider_id'], message: 'Choisissez le prestataire externe.' });
            if (t.execution_mode === 'INTERNAL' && t.provider_id)
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'provider_id'], message: 'Une intervention interne ne prend pas de prestataire externe.' });
            if (t.execution_mode === 'EXTERNAL' && t.responsible_user_id)
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'responsible_user_id'], message: 'Sélectionnez un intervenant interne uniquement pour une intervention interne.' });
        });
});
export const maintenanceScheduleProposalSchema = z.object({
    schedule_id: uuid.nullable().default(null), expected_version: z.number().int().positive().nullable().default(null),
    definition: maintenanceScheduleDefinitionSchema.nullable(), reason: z.string().trim().min(3).max(1000),
}).strict().superRefine((v, ctx) => {
    if (Boolean(v.schedule_id) !== Boolean(v.expected_version))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expected_version'], message: 'L’identifiant et la version existante sont nécessaires ensemble.' });
    if (!v.schedule_id && !v.definition)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['definition'], message: 'La définition est obligatoire pour une nouvelle règle.' });
});
export const publishMaintenanceScheduleSchema = z.object({ proposal: maintenanceScheduleProposalSchema, preview_hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type MaintenanceScheduleDefinition = z.infer<typeof maintenanceScheduleDefinitionSchema>;
export type MaintenanceScheduleProposal = z.infer<typeof maintenanceScheduleProposalSchema>;
