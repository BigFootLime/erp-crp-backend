import { asyncHandler } from "../../../utils/asyncHandler";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { roleHasStockCapability } from "../domain/stock-rbac";
import { stockLaneLocationParams, stockLanePositionsQuery, stockLaneConfigurationCommand } from "../validators/stock-lanes.validators";
import { getStockLaneLocations, getStockLanePositions, setStockLaneLocation } from "../services/stock-lanes.service";

export const readStockLaneLocations = asyncHandler(async (req, res) => {
  res.json({ ...await getStockLaneLocations(), can_configure: requestHasGrantedAccountModuleAccess(req)
    || roleHasStockCapability(req.user?.role, "referential_manage") });
});
export const readStockLanePositions = asyncHandler(async (req, res) => {
  res.json(await getStockLanePositions(stockLanePositionsQuery.parse(req.query)));
});
export const writeStockLaneLocation = asyncHandler(async (req, res) => {
  const { locationId } = stockLaneLocationParams.parse(req.params);
  const result = await setStockLaneLocation(locationId, stockLaneConfigurationCommand.parse(req.body), req.user!.id);
  res.status(result.replayed ? 200 : 201).json(result);
});
