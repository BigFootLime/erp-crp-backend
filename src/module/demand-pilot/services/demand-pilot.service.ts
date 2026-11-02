import * as repo from "../repository/demand-pilot.repository";
export const listDemand = repo.listDemand;
export const getDemand = repo.getDemand;
export const importDemand = repo.importDemand;
export const decideDemand = repo.decideDemand;
export const respondPortalDemand = repo.respondPortalDemand;
/** Planner port: only materialized commercial books may feed the industrial plan. */
export async function listMaterializedPlanningDemand(clientId: string) {
  const result = await repo.listDemand({
    clientId,
    status: "MATERIALIZED",
    page: 1,
    pageSize: 200,
  });
  return result.data;
}
