import type { Paginated, ProgrammationTaskListItem } from "../types/programmation.types";
import type { ListProgrammationsQueryDTO } from "../validators/programmation.validators";
import { repoListProgrammations } from "../repository/programmation.repository";

export async function svcListProgrammations(query: ListProgrammationsQueryDTO): Promise<Paginated<ProgrammationTaskListItem>> {
  return repoListProgrammations(query);
}
