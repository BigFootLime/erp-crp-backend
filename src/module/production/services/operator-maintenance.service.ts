import { HttpError } from "../../../utils/httpError";
import {
  maintenanceCommand,
  maintenanceManager,
} from "../domain/operator-maintenance";
import { repoMaintenanceWorkspace } from "../repository/operator-maintenance-read.repository";
import { repoMaintenanceCommand } from "../repository/operator-maintenance.repository";
export function maintenanceWorkspace(
  machineId: string,
  actor: number,
  roles: (string | null | undefined)[],
) {
  return repoMaintenanceWorkspace(machineId, actor, maintenanceManager(roles));
}
export function maintenanceWrite(
  machineId: string,
  actor: number,
  roles: (string | null | undefined)[],
  body: unknown,
) {
  const parsed = maintenanceCommand.safeParse(body);
  if (!parsed.success)
    throw new HttpError(
      422,
      "MAINTENANCE_INPUT_INVALID",
      "Corrigez les champs du contrôle.",
      { issues: parsed.error.issues },
    );
  return repoMaintenanceCommand(
    machineId,
    parsed.data,
    actor,
    maintenanceManager(roles),
  );
}
