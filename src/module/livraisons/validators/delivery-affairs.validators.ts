import { z } from "zod";
export const deliveryAffairsQuerySchema = z.object({
    q: z.string().trim().max(160).default(""),
    client_id: z.string().trim().min(1).max(120).optional(),
    commande_id: z.coerce.number().int().positive().optional(),
    affaire_id: z.coerce.number().int().positive().optional(),
    state: z.enum(["ALL", "PENDING", "PARTIAL", "COMPLETE"]).default("ALL"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(24),
}).strict();
export type DeliveryAffairsQuery = z.infer<typeof deliveryAffairsQuerySchema>;
