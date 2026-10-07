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
  const resolved = await resolveIdentification(
    {
      event_id: eventId,
      code,
      source: "KEYBOARD",
      flow: "CONSUME",
      expected_entity_types: ["STOCK_LOT"],
      client_scanned_at: new Date().toISOString(),
      device_id: station.device_code,
    },
    {
      user_id: station.user.id,
      role: station.user.role,
      request_id: null,
      correlation_id: null,
    },
  );
  if (!resolved.ok || resolved.entity?.type !== "STOCK_LOT")
    throw new HttpError(422, "STATION_CUTTING_SCAN_REFUSED", resolved.message);
  const material = await getOfMaterial(ofId);
  const reservations = material.enabled
    ? material.needs
        .filter((n) => n.operationId === operationId)
        .flatMap((n) => n.reservations)
        .filter(
          (r) =>
            r.lot_id === resolved.entity!.id &&
            r.status === "ACTIVE" &&
            r.unexpired &&
            r.qty_reserved > r.qty_consumed,
        )
    : [];
  if (!reservations.length)
    throw new HttpError(
      409,
      "STATION_CUTTING_LOT_NOT_RESERVED",
      "Ce lot n’est pas réservé pour cette découpe. Choisissez une barre proposée ou faites vérifier la préparation.",
    );
  return {
    lotId: resolved.entity.id,
    lotCode: resolved.entity.code,
    reservationIds: reservations.map((r) => r.id),
    message: "Lot identifié. Choisissez la barre puis confirmez les quantités.",
  };
}
