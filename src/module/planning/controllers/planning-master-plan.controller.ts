import type { RequestHandler } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler';
import { getMasterPlan } from '../services/planning-master-plan.service';
import { masterPlanQuerySchema } from '../validators/planning-master-plan.validators';

export const masterPlan: RequestHandler = asyncHandler(async (req, res) => {
  const result = await getMasterPlan(masterPlanQuerySchema.parse(req.query));
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
});
