import { z } from 'zod';
export const recoveryConsolidationParams=z.object({recoveryId:z.string().uuid(),consolidationId:z.string().uuid()}).strict();
