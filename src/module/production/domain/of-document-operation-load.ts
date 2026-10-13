import type { OfRevisionOperation } from "./of-revision";
import { phaseFabricationTime, phaseFinalTime } from "./of-revision";
import { computePlannedOperationDurationMinutes } from "./planned-operation-duration";

/** Saved legacy payloads omit launchedQuantity; modern editions use the scheduling formula. */
export function documentOperationLoad(operation: OfRevisionOperation, launchedQuantity?: number): { fabricationHours: number; finalHours: number } {
  if (launchedQuantity === undefined) return { fabricationHours:phaseFabricationTime(operation),finalHours:phaseFinalTime(operation) };
  const finalMinutes=computePlannedOperationDurationMinutes({
    setupHours:operation.preparation,unitHours:operation.tempsUnitaire,
    baseQuantity:operation.quantiteBase,launchedQuantity,coefficient:operation.coefficient,
  });
  return {fabricationHours:phaseFabricationTime(operation)*launchedQuantity,finalHours:finalMinutes/60};
}
