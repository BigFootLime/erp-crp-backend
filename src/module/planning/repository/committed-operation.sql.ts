/** A treatment is committed by the central scheduler without a machine event. */
export function committedOperationSql(operation: string, order: string): string {
  return `(
    ${operation}.status IN ('RUNNING','DONE')
    OR EXISTS (
      SELECT 1 FROM public.planning_events e
      WHERE e.of_operation_id=${operation}.id AND e.archived_at IS NULL
        AND e.status<>'CANCELLED' AND e.end_ts>e.start_ts
        AND (e.machine_id IS NOT NULL OR e.poste_id IS NOT NULL)
    )
    OR EXISTS (
      SELECT 1 FROM public.planning_tasks t
      WHERE t.operation_id=${operation}.id AND t.committed_end>t.committed_start
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(${order}.technical_snapshot->'operations','[]'::jsonb)) f
          WHERE f->>'phase'=${operation}.phase::text AND f->>'type_operation'='SOUS_TRAITANCE'
        )
    )
  )`;
}
