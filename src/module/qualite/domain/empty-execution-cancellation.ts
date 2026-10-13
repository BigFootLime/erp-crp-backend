import { HttpError } from '../../../utils/httpError';

export type EmptyExecutionCancellationState = {
  status: string;
  validationDate: string | null;
  measurementCount: number;
  measurementRevisionCount: number;
  decisionCount: number;
  quantities: readonly number[];
};

/** Undo an erroneous empty workspace, never a quality finding or decision. */
export function assertEmptyExecutionCancellation(state: EmptyExecutionCancellationState): void {
  if (!['PLANNED', 'IN_PROGRESS'].includes(state.status) || state.validationDate) {
    throw new HttpError(409, 'QUALITY_CANCELLATION_CLOSED', 'Ce contrôle est déjà fermé.');
  }
  if (state.measurementCount !== 0 || state.measurementRevisionCount !== 0) {
    throw new HttpError(409, 'QUALITY_CANCELLATION_HAS_MEASUREMENTS',
      'Un contrôle avec des mesures conserve son circuit de correction.');
  }
  if (state.decisionCount !== 0 || state.quantities.some(value => !Number.isFinite(value) || value !== 0)) {
    throw new HttpError(409, 'QUALITY_CANCELLATION_HAS_DECISION',
      'Un contrôle avec une décision ou des quantités traitées ne peut pas être annulé.');
  }
}
