import { HttpError } from "../../../utils/httpError";
import { repoListAssignableUsers } from "../../users/repository/users.repository";
import { readAssemblyOperations, readAssemblyWeekSettings, writeAssemblyWeek } from "../repository/assembly-planning.repository";
import { members, presenceSchema, type SaveAssemblyWeek } from "../validators/assembly-planning.validators";

const teamLabels = ["Florence Berliet", "Nizier", "Clément"];
const normalize = (name: string) => name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

async function assemblyUsers() {
  return (await repoListAssignableUsers({ limit: 500 })).map((user) => ({
    id: user.id,
    label: [user.name, user.surname].filter(Boolean).join(" ") || user.username,
    names: [user.name, user.surname, user.username, [user.name, user.surname].filter(Boolean).join(" ")]
      .filter((name): name is string => Boolean(name)).map(normalize),
  }));
}

export async function getAssemblyWeek(week: string, canManage: boolean) {
  const [users, { teamSetting, weekSetting }, operations] = await Promise.all([
    assemblyUsers(), readAssemblyWeekSettings(week), readAssemblyOperations(week),
  ]);
  const defaults = teamLabels.map((label) => {
    const matches = users.filter((user) => user.names.includes(normalize(label)));
    return matches.length === 1 ? matches[0].id : null;
  }).map((id, index, ids) => id !== null && ids.indexOf(id) !== index ? null : id);
  const team = members.safeParse(teamSetting?.value_json).data ?? defaults;
  return {
    week,
    team: teamLabels.map((label, index) => ({ label, userId: team[index] })),
    users: users.filter((user) => canManage || team.includes(user.id)).map(({ id, label }) => ({ id, label })),
    presence: presenceSchema.safeParse(weekSetting?.value_json).data ?? [],
    teamVersion: teamSetting?.version ?? null,
    weekVersion: weekSetting?.version ?? null,
    operations: operations.filter((op) => op.start_ts !== null),
    unplanned: operations.filter((op) => op.start_ts === null),
  };
}

export async function saveAssemblyWeek(input: SaveAssemblyWeek, actorId: number | null) {
  const users = await assemblyUsers();
  const selected = input.team.filter((id): id is number => id !== null);
  if (selected.some((id) => !users.some((user) => user.id === id))) {
    throw new HttpError(422, "ASSEMBLY_USER_UNAVAILABLE", "Sélectionnez des comptes actifs.");
  }
  const presenceIds = input.presence.map((entry) => entry.userId);
  if (new Set(presenceIds).size !== presenceIds.length || presenceIds.some((id) => !selected.includes(id))) {
    throw new HttpError(422, "ASSEMBLY_PRESENCE_INVALID", "Les horaires doivent correspondre aux comptes sélectionnés.");
  }
  return writeAssemblyWeek(input, actorId);
}
