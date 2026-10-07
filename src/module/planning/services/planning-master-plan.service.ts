import { projectMasterPlan } from '../domain/planning-master-plan';
import { readMasterPlanSource } from '../repository/planning-master-plan.repository';
import type { MasterPlanQuery } from '../validators/planning-master-plan.validators';
import { assertCentralActivation } from './planning-central.service';

export async function getMasterPlan(query: MasterPlanQuery) {
  const { snapshot, orders, periods } = await readMasterPlanSource(query);
  assertCentralActivation(snapshot.activation, 'READ');
  return projectMasterPlan(snapshot, orders, periods);
}
