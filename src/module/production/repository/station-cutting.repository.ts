import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { StationContext } from "../middlewares/station-authorization.middleware";

/** Device then session: same lock order as identification/revocation. */
export async function authorizeCuttingTx(
  tx: PoolClient,
  station: StationContext,
  ofId: number,
  operationId: string,
) {
  const device = (
    await tx.query(
      `SELECT status FROM public.production_devices WHERE id=$1::uuid FOR SHARE`,
      [station.device_id],
    )
  ).rows[0];
  if (!device || device.status !== "ACTIVE")
    throw new HttpError(
      403,
      "STATION_DEVICE_DISABLED",
      "Ce poste n’est plus autorisé.",
    );
  const session = (
    await tx.query(
      `SELECT user_id,machine_id,
    state='ACTIVE' AND expires_at>clock_timestamp() AND last_activity_at>clock_timestamp()-make_interval(secs=>$2) AS usable
    FROM public.operator_device_sessions WHERE id=$1::uuid AND device_id=$3::uuid FOR SHARE`,
      [station.session_id, station.auto_lock_seconds, station.device_id],
    )
  ).rows[0];
  if (
    !session?.usable ||
    Number(session.user_id) !== station.user.id ||
    session.machine_id !== station.machine_id
  )
    throw new HttpError(
      401,
      "STATION_SESSION_LOCKED",
      "Identifiez-vous à nouveau sur le poste avant de reprendre la découpe.",
    );
  await assertCuttingTarget(tx, station, ofId, operationId);
}

export async function assertCuttingTarget(
  tx: Pick<PoolClient, "query">,
  station: StationContext,
  ofId: number,
  operationId: string,
) {
  const op = (
    await tx.query(
      `SELECT op.machine_id,EXISTS(SELECT 1 FROM public.of_material_needs n
    WHERE n.of_id=op.of_id AND n.operation_id=op.id AND n.need_kind='MATIERE' AND n.superseded_at IS NULL
      AND n.technical_version_id=o.piece_technique_version_id) AS material_operation
    FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id WHERE op.of_id=$1 AND op.id=$2::uuid`,
      [ofId, operationId],
    )
  ).rows[0];
  if (!op?.material_operation)
    throw new HttpError(
      404,
      "STATION_CUTTING_OPERATION_UNKNOWN",
      "Cette opération ne comporte pas de débit matière préparé.",
    );
  if (
    !station.machine_id ||
    (op.machine_id && op.machine_id !== station.machine_id)
  )
    throw new HttpError(
      409,
      "STATION_CUTTING_MACHINE_CONFLICT",
      "Choisissez la machine de cette opération avant de découper.",
    );
}

export async function assertCuttingRead(
  station: StationContext,
  ofId: number,
  operationId: string,
) {
  await assertCuttingTarget(pool, station, ofId, operationId);
}

export async function cuttingPointageTx(
  tx: PoolClient,
  station: StationContext,
  ofId: number,
  operationId: string,
) {
  const row = (
    await tx.query(
      `SELECT id::text FROM public.production_pointages WHERE of_id=$1 AND operation_id=$2::uuid
    AND operator_user_id=$3 AND machine_id=$4::uuid AND status='RUNNING'`,
      [ofId, operationId, station.user.id, station.machine_id],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      409,
      "STATION_CUTTING_POINTAGE_REQUIRED",
      "Démarrez la découpe sur ce poste avant d’enregistrer la matière.",
    );
  return row.id as string;
}
