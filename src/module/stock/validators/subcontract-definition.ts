import { z } from "zod";
export const subcontractDefinitionSchema=z.object({
  piece_technique_id:z.string().uuid(),
  piece_technique_version_id:z.string().uuid(),
  family_label:z.string().trim().min(1).max(200),
  description:z.string().trim().min(1).max(4000),
  material_provider:z.enum(["CRP","SUPPLIER"]),
  plan_reference:z.string().trim().min(1).max(200),
  comment:z.string().trim().max(4000).nullable().optional(),
}).strict();
export type SubcontractDefinition = z.infer<typeof subcontractDefinitionSchema>;
