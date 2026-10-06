import { asyncHandler } from '../../../utils/asyncHandler';
import { buildAuditContext } from './production.controller';
import { productionLossIdentity, productionLossCommand } from '../validators/production-loss.validators';
import { readProductionLosses, createLossComplement } from '../services/production-loss.service';
import { roleHasOfCapability } from '../domain/of-rbac';
import { requestHasGrantedAccountModuleAccess } from '../../access-control/context/account-module-access.context';
export const readLosses = asyncHandler(async (req, res) => res.json({ ...await readProductionLosses(productionLossIdentity.parse(req.params).id), canCreate: requestHasGrantedAccountModuleAccess(req) || roleHasOfCapability(req.user?.role, 'create') }));
export const createComplement = asyncHandler(async (req, res) => res.status(201).json(await createLossComplement(productionLossIdentity.parse(req.params).id, productionLossCommand.parse(req.body), buildAuditContext(req))));
