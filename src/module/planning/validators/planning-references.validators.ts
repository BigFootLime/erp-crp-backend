import { z } from "zod";

export const planningReferenceOfListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  statut: z.enum(["BROUILLON", "PLANIFIE", "EN_COURS", "EN_PAUSE", "TERMINE", "CLOTURE", "ANNULE"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const planningReferenceOfParamSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

export type PlanningReferenceOfListQuery = z.infer<typeof planningReferenceOfListQuerySchema>;
