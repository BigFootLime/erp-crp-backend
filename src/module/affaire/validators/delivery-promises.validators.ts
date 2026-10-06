import { z } from "zod";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const reviseDeliveryPromisesSchema = z.object({
    root_id: z.string().uuid(), expected_version: z.coerce.number().int().positive(),
    request_key: z.string().uuid(), reason: z.string().trim().min(5).max(2000),
    parts: z.array(z.object({ quantity: z.number().positive().max(100000000).multipleOf(0.000001), due_date: date }).strict()).min(1).max(50),
}).strict();
export type ReviseDeliveryPromisesInput = z.infer<typeof reviseDeliveryPromisesSchema>;
