import { z } from "zod";
import { crmClientIdSchema, crmIdempotencySchema } from "./client-crm.validators";

export const contractClientIdSchema = crmClientIdSchema;
export const contractIdempotencySchema = crmIdempotencySchema;
const uuid = z.string().uuid().transform(value=>value.toLowerCase());
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
}, "Date invalide").nullable();
const definition = {
  reference: z.string().trim().min(1).max(100), title: z.string().trim().min(1).max(200),
  valid_from: date, valid_until: date, status: z.enum(["DRAFT", "ACTIVE"]),
  lines: z.array(z.object({ article_id: uuid, replenishment_qty: z.number().positive().max(1_000_000_000)
    .refine(value => Math.abs(value*1000-Math.round(value*1000))<0.00001,"Maximum trois décimales") }).strict()).min(1).max(100),
};
const version = z.number().int().positive().max(2147483646);
export const clientContractCommandSchema = z.discriminatedUnion("action",[
  z.object({ action:z.literal("CREATE"), ...definition }).strict(),
  z.object({ action:z.literal("UPDATE"), contract_id:uuid, expected_version:version,
    reason:z.string().trim().min(3).max(500), ...definition }).strict(),
  z.object({ action:z.literal("CLOSE"), contract_id:uuid, expected_version:version,
    reason:z.string().trim().min(3).max(500) }).strict(),
]).superRefine((value,ctx) => {
  if(value.action==="CLOSE") return;
  if(value.valid_from && value.valid_until && value.valid_until<value.valid_from)
    ctx.addIssue({code:z.ZodIssueCode.custom,path:["valid_until"],message:"La fin précède le début du contrat"});
  if(new Set(value.lines.map(line=>line.article_id)).size!==value.lines.length)
    ctx.addIssue({code:z.ZodIssueCode.custom,path:["lines"],message:"Un article ne peut apparaître qu’une fois"});
});
export type ClientContractCommand = z.infer<typeof clientContractCommandSchema>;
export const clientContractQuerySchema=z.object({ page:z.coerce.number().int().positive().max(100000).default(1) }).strict();
export const clientContractArticleQuerySchema=z.object({ q:z.string().trim().max(160).default("") }).strict();
