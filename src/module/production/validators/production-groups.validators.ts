import { z } from "zod";

function emptyStringToUndefined(value: unknown) {
  if (typeof value !== "string") return value;
  return value.trim() === "" ? undefined : value;
}

function emptyStringToNull(value: unknown) {
  if (typeof value !== "string") return value;
  return value.trim() === "" ? null : value;
}

export const productionGroupIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const listProductionGroupsQuerySchema = z.object({
  q: z.string().optional(),
  client_id: z.string().optional(),
  piece_technique_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["updated_at", "code"]).optional().default("updated_at"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type ListProductionGroupsQueryDTO = z.infer<typeof listProductionGroupsQuerySchema>;

export const createProductionGroupBodySchema = z
  .object({
    code: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(120)).optional(),
    client_id: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(120)).optional().nullable(),
    piece_technique_id: z.preprocess(emptyStringToNull, z.string().uuid()).optional().nullable(),
    piece_code: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(200)).optional().nullable(),
    piece_label: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(1000)).optional().nullable(),
    description: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(20000)).optional().nullable(),
    notes: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(20000)).optional().nullable(),
  })
  .passthrough();

export type CreateProductionGroupBodyDTO = z.infer<typeof createProductionGroupBodySchema>;

export const updateProductionGroupBodySchema = z
  .object({
    client_id: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(120)).optional().nullable(),
    piece_technique_id: z.preprocess(emptyStringToNull, z.string().uuid()).optional().nullable(),
    piece_code: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(200)).optional().nullable(),
    piece_label: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(1000)).optional().nullable(),
    description: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(20000)).optional().nullable(),
    notes: z.preprocess(emptyStringToNull, z.string().trim().min(1).max(20000)).optional().nullable(),
  })
  .passthrough();

export type UpdateProductionGroupBodyDTO = z.infer<typeof updateProductionGroupBodySchema>;

export const linkProductionGroupBodySchema = z
  .object({
    affaire_ids: z.array(z.coerce.number().int().positive()).optional().default([]),
    of_ids: z.array(z.coerce.number().int().positive()).optional().default([]),
  })
  .passthrough();

export type LinkProductionGroupBodyDTO = z.infer<typeof linkProductionGroupBodySchema>;

export const unlinkProductionGroupBodySchema = z
  .object({
    affaire_ids: z.array(z.coerce.number().int().positive()).optional().default([]),
    of_ids: z.array(z.coerce.number().int().positive()).optional().default([]),
  })
  .passthrough();

export type UnlinkProductionGroupBodyDTO = z.infer<typeof unlinkProductionGroupBodySchema>;
