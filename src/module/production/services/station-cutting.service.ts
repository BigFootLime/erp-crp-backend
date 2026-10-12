import { HttpError } from "../../../utils/httpError";
import type { StationContext } from "../middlewares/station-authorization.middleware";
import type { AuditContext } from "../repository/production.repository";
import type { MaterialDebit } from "../validators/of-material.validators";
import { getOfMaterial } from "../repository/of-material.repository";
import { getOperationReadiness } from "../repository/operation-readiness.repository";
import { debitOfMaterial } from "../repository/of-material-debit.repository";
import {
  assertCuttingRead,
  authorizeCuttingTx,
  cuttingPointageTx,
} from "../repository/station-cutting.repository";
import { cuttingScanSource } from "../domain/station-cutting-scan";
import { repoFindScanEvent } from "../../identification/identification.repository";
import { resolveIdentification } from "../../identification/identification.service";
import { roleHasOfCapability } from "../domain/of-rbac";
import type { PoolClient } from "pg";

export type CuttingTransactionAuthorization = (tx: PoolClient) => Promise<void>;

function operatorMaterial(data: Awaited<ReturnType<typeof getOfMaterial>>) {
  if (!data.enabled) return data;
  return {
    ...data,
    permissions: {
      canConfigure: false,
      canVerifyLot: false,
      canConfirm: false,
      canPurchase: false,
      canReadPrices: false,
    },
    needs: data.needs.map((n) => ({
      ...n,
      price: null,
      catalog: null,
      futureSupplies: [],
      promises: [],
    })),
    suppliers: [],
    customerCalls: [],
  };
}
export async function readStationCutting(
  station: StationContext,
  ofId: number,
  operationId: string,
) {
  await assertCuttingRead(station, ofId, operationId);
  const [material, readiness] = await Promise.all([
    getOfMaterial(ofId),
    getOperationReadiness(ofId),
  ]);
  const operation = readiness.enabled
    ? readiness.operations.find((op) => op.id === operationId)
    : null;
  if (!material.enabled || !operation?.materialOperation)
    throw new HttpError(
      409,
      "STATION_CUTTING_UNAVAILABLE",
      "La préparation matière n’est pas disponible.",
    );
  return { material: operatorMaterial(material), operation };
}
export async function debitStationCutting(
  station: StationContext,
  ofId: number,
  body: MaterialDebit,
  audit: AuditContext,
  authorizeTransaction?: CuttingTransactionAuthorization,
) {
  if (!roleHasOfCapability(station.user.role, "operate"))
    throw new HttpError(
      403,
      "STATION_CUTTING_FORBIDDEN",
      "Les droits de déclaration atelier sont nécessaires.",
    );
  const result = await debitOfMaterial(ofId, body, audit, {
    authorizeTransaction: authorizeTransaction ?? ((tx) =>
      authorizeCuttingTx(tx, station, ofId, body.operationId)
    ),
    resolvePointage: (tx) =>
      cuttingPointageTx(tx, station, ofId, body.operationId),
  });
  return { ...result, coverage: operatorMaterial(result.coverage) };
}
export async function scanStationCutting(
  station: StationContext,
  ofId: number,
  operationId: string,
  code: string,
  eventId: string,
) {
  await assertCuttingRead(station, ofId, operationId);
  const previous = await repoFindScanEvent(eventId);
  const resolved = await resolveIdentification(
    {
      event_id: eventId,
      code,
      source: "KEYBOARD",
      flow: "CONSUME",
      expected_entity_types: ["STOCK_LOT", "STOCK_MATERIAL_BAR"],
      client_scanned_at: previous?.actor_user_id === station.user.id ? previous.client_scanned_at : new Date().toISOString(),
      device_id: station.device_code,
    },
    {
      user_id: station.user.id,
      role: station.user.role,
      request_id: null,
      correlation_id: null,
    },
  );
  if (!resolved.ok || !resolved.entity || !["STOCK_LOT", "STOCK_MATERIAL_BAR"].includes(resolved.entity.type))
    throw new HttpError(422, "STATION_CUTTING_SCAN_REFUSED", resolved.message);
  const material = await getOfMaterial(ofId);
  return cuttingScanSource(material.enabled ? material.needs : [], operationId,
    { ...resolved.entity, type: resolved.entity.type as "STOCK_LOT" | "STOCK_MATERIAL_BAR" });
}
