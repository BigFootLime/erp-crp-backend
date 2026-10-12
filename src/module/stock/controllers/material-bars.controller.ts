import { asyncHandler } from '../../../utils/asyncHandler';
import { roleHasStockCapability } from '../domain/stock-rbac';
import { requestHasGrantedAccountModuleAccess } from '../../access-control/context/account-module-access.context';
import { materialBarBatchParams, materialBarInventoryCommand } from '../validators/material-bars.validators';
import { readMaterialBarInventory, confirmMaterialBarInventory } from '../services/material-bars.service';

export const getMaterialBarInventory = asyncHandler(async (req, res) => {
  const { batchId } = materialBarBatchParams.parse(req.params);
  res.json({ ...await readMaterialBarInventory(batchId), canConfirm: requestHasGrantedAccountModuleAccess(req)
    || roleHasStockCapability(req.user?.role, 'inventory_approve') });
});
export const putMaterialBarInventory = asyncHandler(async (req, res) => {
  const { batchId } = materialBarBatchParams.parse(req.params);
  const body = materialBarInventoryCommand.parse(req.body);
  const result = await confirmMaterialBarInventory(batchId, body, {
    user_id: req.user!.id, ip: req.ip ?? null, user_agent: req.get('user-agent') ?? null,
    device_type: null, os: null, browser: null, path: req.originalUrl ?? null,
    page_key: req.get('x-page-key') ?? null, client_session_id: req.get('x-client-session-id') ?? null,
  });
  res.status(result.replayed ? 200 : 201).json(result);
});
