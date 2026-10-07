import type { CentralTask, ScheduleResult } from '../types/planning-central.types';

/** Persist a date and its calculated resource together, including invalidation. */
export function forecastPlacements(tasks: CentralTask[], result: ScheduleResult) {
  const choices = new Map(result.changes.map(change => [change.taskId, change.resourceIds]));
  const problems = new Map<string, string[]>();
  for (const issue of result.conflicts) {
    problems.set(issue.taskId, [...(problems.get(issue.taskId) ?? []), issue.message]);
  }
  return tasks.map(task => {
    const issues = problems.get(task.id) ?? [];
    const projection = issues.length ? null : result.forecasts[task.id];
    const resources = projection ? [...(choices.get(task.id) ?? task.resourceIds)] : null;
    return { id: task.id, start: projection?.start ?? null, end: projection?.end ?? null, resources, issues };
  });
}
