import type { DossierDb } from '../../production/repository/of-dossier.repository';
import { materialWorkflowEnabled } from '../../production/repository/of-dossier.repository';
import { readMaterialTx } from '../../production/repository/of-material.repository';
import { readMaterialReservationAvailabilityTx } from '../../production/repository/material-reservation-availability.repository';
import type { CentralTask, CoverageSource } from '../types/planning-central.types';
import { emptyPlanningCoverage, projectMaterialCoverage } from '../domain/planning-material-coverage';

export async function readPlanningCoverageTx(tx: DossierDb, tasks: CentralTask[], now: string) {
  const result = emptyPlanningCoverage();
  if (!await materialWorkflowEnabled(tx)) return result;
  result.coverageAvailable = true;
  const sources = new Map<string, CoverageSource>();
  for (const ofId of [...new Set(tasks.flatMap(t => t.ofId === null ? [] : [t.ofId]))]) {
    const material = await readMaterialTx(tx, ofId);
    const availability = await readMaterialReservationAvailabilityTx(tx, material);
    const coverage = projectMaterialCoverage(material, tasks, availability, now);
    for (const source of coverage.sources) {
      const previous = sources.get(source.id);
      if (!previous || previous.quantity < source.quantity) sources.set(source.id, source);
    }
    result.demands.push(...coverage.demands);
    result.allocations.push(...coverage.allocations);
  }
  result.sources = [...sources.values()];
  return result;
}
