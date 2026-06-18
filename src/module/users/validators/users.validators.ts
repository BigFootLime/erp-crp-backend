import { z } from "zod";

export const listAssignableUsersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export type ListAssignableUsersQueryDTO = z.infer<typeof listAssignableUsersQuerySchema>;
