import { getAccountModuleAccessContext } from "../../access-control/context/account-module-access.context";
import { HttpError } from "../../../utils/httpError";
import { repoFindActivePeriodClosure } from "../repository/temps-deplacements-operations.repository";

export type HrActor = { id: number; role: string };

export function isHrPrivileged(role: string): boolean {
  if (getAccountModuleAccessContext()?.elevated === true) return true;
  const normalized = role.toLowerCase();
  return normalized.includes("rh")
    || normalized.includes("directeur")
    || normalized.includes("direction")
    || normalized.includes("administrateur");
}

export async function assertPeriodOpen(employeeId: string, from: string, to = from): Promise<void> {
  const closure = await repoFindActivePeriodClosure(employeeId, from, to);
  if (closure) {
    throw new HttpError(
      409,
      "HR_PERIOD_CLOSED",
      `Période clôturée du ${closure.period_start} au ${closure.period_end}. Demandez une réouverture RH avant toute correction.`,
    );
  }
}
