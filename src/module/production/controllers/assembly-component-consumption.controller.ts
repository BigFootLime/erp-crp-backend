import { z } from 'zod';
import { asyncHandler } from '../../../utils/asyncHandler';
import { HttpError } from '../../../utils/httpError';
import { consumableAccountRights } from '../../stock/domain/consumable-access';
import { buildAuditContext } from './production.controller';
import { assemblyComponentPreviewSchema, assemblyComponentWithdrawalSchema, assemblyComponentReturnSchema } from '../validators/assembly-component-consumption.validators';
import { getAssemblyComponentPreparation, withdrawAssemblyComponents, getAssemblyComponentWithdrawals, getAssemblyComponentReturn, returnAssemblyComponents } from '../services/assembly-component-consumption.service';
import { canReturnAssemblyComponents } from '../domain/assembly-component-access';

const ofId = z.coerce.number().int().positive();
export const readAssemblyComponents = asyncHandler(async (req, res) => {
  const permissions = await consumableAccountRights(req);
  const query = assemblyComponentPreviewSchema.parse(req.query);
  res.json({ ...await getAssemblyComponentPreparation(ofId.parse(req.params.id), query.quantity), permissions: { withdraw: permissions.withdraw } });
});
export const issueAssemblyComponents = asyncHandler(async (req, res) => {
  if (!(await consumableAccountRights(req)).withdraw) {
    throw new HttpError(403, 'ASSEMBLY_COMPONENT_WITHDRAWAL_FORBIDDEN', 'Les droits de consommation des réservations et de sortie stock sont nécessaires.');
  }
  res.json(await withdrawAssemblyComponents(ofId.parse(req.params.id), assemblyComponentWithdrawalSchema.parse(req.body), buildAuditContext(req)));
});

export const readAssemblyWithdrawals = asyncHandler(async (req, res) => {
  res.json(await getAssemblyComponentWithdrawals(ofId.parse(req.params.id)));
});
export const previewAssemblyReturn = asyncHandler(async (req, res) => {
  const allowed = await canReturnAssemblyComponents(req);
  res.json({ ...await getAssemblyComponentReturn(ofId.parse(req.params.id), z.string().uuid().parse(req.params.withdrawalId)),
    permissions: { return: allowed } });
});
export const submitAssemblyReturn = asyncHandler(async (req, res) => {
  if (!await canReturnAssemblyComponents(req)) throw new HttpError(403, 'ASSEMBLY_COMPONENT_RETURN_FORBIDDEN', 'Les droits de correction stock sont nécessaires.');
  res.json(await returnAssemblyComponents(ofId.parse(req.params.id), z.string().uuid().parse(req.params.withdrawalId),
    assemblyComponentReturnSchema.parse(req.body), buildAuditContext(req)));
});
