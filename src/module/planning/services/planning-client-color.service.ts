import { repoListPlanningClientColors, repoSetPlanningClientColor } from "../repository/planning-client-color.repository";
import type { AuditContext } from "../repository/planning.repository";
export const svcListPlanningClientColors = () => repoListPlanningClientColors();
export const svcSetPlanningClientColor = (clientId: string, color: string | null, audit: AuditContext) => repoSetPlanningClientColor(clientId, color, audit);
