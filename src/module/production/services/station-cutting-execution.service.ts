import { HttpError } from "../../../utils/httpError";
import type { StationContext } from "../middlewares/station-authorization.middleware";
import type { AuditContext } from "../repository/production.repository";
import {
  assertCuttingRead,
  authorizeCuttingTx,
  assertCuttingTarget,
  assertCuttingPointageTargetTx,
} from "../repository/station-cutting.repository";
import type { CuttingExecutionCommand } from "../validators/station-cutting.validators";
import type { CuttingTransactionAuthorization } from "./station-cutting.service";
import {
  svcStartExecution,
  svcPauseExecution,
  svcResumeExecution,
  svcStopExecution,
  svcPreviewFinishOperation,
  svcFinishOperation,
} from "./production-execution.service";

/** Thin session adapter; all time and finish effects remain in canonical execution. */
export async function executeStationCutting(params: {
  station: StationContext;
  ofId: number;
  operationId: string;
  command: CuttingExecutionCommand;
  idempotencyKey: string;
  audit: AuditContext;
  authorizeTransaction?: CuttingTransactionAuthorization;
}) {
  const { station, ofId, operationId, command, idempotencyKey } = params;
  const audit = {
    ...params.audit,
    user_id: station.user.id,
    user_role: station.user.role,
  };
  const machineId = await assertCuttingRead(station, ofId, operationId);
  const actor = { id: station.user.id, role: station.user.role };
  const context = { actor, audit, idempotencyKey };
  const transactionHooks = {
    beforeCommit: async () => undefined,
    beforeEffect: async (tx: import("pg").PoolClient) => {
      if (params.authorizeTransaction) await params.authorizeTransaction(tx);
      else await authorizeCuttingTx(tx, station, ofId, operationId);
      if (command.command === "start") {
        const current = await assertCuttingTarget(tx, ofId, operationId);
        if (current !== machineId)
          throw new HttpError(
            409,
            "STATION_CUTTING_ASSIGNMENT_CHANGED",
            "L’affectation de cet OF a changé. Rechargez le dossier avant de commencer.",
          );
      }
      if ("id" in command.payload)
        await assertCuttingPointageTargetTx(
          tx,
          station,
          ofId,
          operationId,
          command.payload.id,
        );
    },
  };
  if (
    "of_id" in command.payload &&
    (command.payload.of_id !== ofId ||
      command.payload.operation_id !== operationId)
  ) {
    throw new HttpError(
      422,
      "STATION_CUTTING_OPERATION_CONFLICT",
      "La commande doit correspondre à l’OF ouvert.",
    );
  }
  switch (command.command) {
    case "start":
      return svcStartExecution({
        ...context,
        body: { ...command.payload, machine_id: machineId },
        source: "station_cutting",
        transactionHooks,
      });
    case "pause":
      return svcPauseExecution({
        ...context,
        id: command.payload.id,
        body: command.payload.payload,
        transactionHooks,
      });
    case "resume":
      return svcResumeExecution({
        ...context,
        id: command.payload.id,
        body: command.payload.payload,
        transactionHooks,
      });
    case "stop":
      return svcStopExecution({
        ...context,
        id: command.payload.id,
        body: command.payload.payload,
        transactionHooks,
      });
    case "preview-finish":
      return svcPreviewFinishOperation({ actor, body: command.payload });
    case "finish":
      return svcFinishOperation({
        ...context,
        body: command.payload,
        transactionHooks,
      });
  }
}
