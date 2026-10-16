import { HttpError } from "../../../utils/httpError";
import { repoFindActivePeriodClosure } from "../repository/temps-deplacements-operations.repository";

export type HrActor = {
  id: number;
  role: string;
  /** Set only from the live sensitive-capability middleware on an HR route. */
  hrSensitiveRead?: boolean;
  hrSensitiveWrite?: boolean;
};

export function isHrPrivileged(actor: HrActor): boolean {
  // Job titles and module grants remain descriptive/access-scoping only. A
  // sensitive HR action is available solely after its route has loaded a live
  // nominative capability for the authenticated account.
  return actor.hrSensitiveRead === true || actor.hrSensitiveWrite === true;
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
