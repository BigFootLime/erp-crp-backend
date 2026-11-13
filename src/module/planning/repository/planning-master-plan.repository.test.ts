import { describe, expect, it } from 'vitest';
import { MASTER_PLAN_ORDERS_SQL, masterPlanOrdersSql } from './planning-master-plan.repository';

describe('master plan cutover WIP checkpoints', () => {
  it('keeps ordinary OF planning unchanged when the optional checkpoint migration is absent', () => {
    const sql = masterPlanOrdersSql(false);
    expect(sql).toBe(MASTER_PLAN_ORDERS_SQL);
    expect(sql).not.toContain('data_cutover_wip_operation_checkpoints');
    expect(sql).toContain("op.status::text<>'CANCELLED'");
  });

  it('counts and recalculates only the remaining phases of a resumed OF', () => {
    const sql = masterPlanOrdersSql(true);
    const completedFilter = "checkpoint.checkpoint_status='COMPLETED'";

    // The same read-only exclusion applies to the operation count, planning
    // issues and task IDs that feed the central recomputation.
    expect(sql.match(new RegExp(completedFilter, 'g'))).toHaveLength(3);
    expect(sql).toContain('JOIN public.data_cutover_wip_resumptions resume ON resume.id=checkpoint.resumption_id');
    expect(sql).toContain('resume.of_id=o.id');
    expect(sql).toContain('checkpoint.of_operation_id=op.id');
    expect(sql).toContain('AS "operationCount"');
    expect(sql).toContain('AS "forecastIssues"');
    expect(sql).toContain('AS "taskIds"');
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('does not exclude an in-progress or not-started opening phase', () => {
    const sql = masterPlanOrdersSql(true);
    expect(sql).toContain("checkpoint.checkpoint_status='COMPLETED'");
    expect(sql).not.toContain("checkpoint.checkpoint_status IN ('NOT_STARTED','IN_PROGRESS')");
  });
});
