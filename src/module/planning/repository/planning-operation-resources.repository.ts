import type { PoolClient } from "pg";

export async function readOperationQualifications(tx:Pick<PoolClient,"query">,operationIds:string[],defaultPostes:Record<string,string|null>) {
  const { rows: qualifications } = await tx.query<{id:string;family:string|null;operation_type:string|null;eligible:string[]}>(`
      WITH qualified_resources AS (
        SELECT 'machine:'||m.id::text AS id,upper(btrim(m.machine_family_code)) AS family
        FROM public.machines m WHERE m.archived_at IS NULL AND m.status::text='ACTIVE' AND m.is_available IS NOT FALSE AND NOT EXISTS(SELECT 1 FROM public.production_maintenance_holds h WHERE h.machine_id=m.id AND h.resolved_at IS NULL)
          AND COALESCE((to_jsonb(m)->>'scheduling_enabled')::boolean,true)
        UNION ALL
        SELECT 'poste:'||p.id::text,upper(btrim(m.machine_family_code))
        FROM public.postes p JOIN public.machines m ON m.id=p.machine_id
        WHERE p.is_active AND p.archived_at IS NULL AND m.archived_at IS NULL AND m.status::text='ACTIVE' AND m.is_available IS NOT FALSE AND NOT EXISTS(SELECT 1 FROM public.production_maintenance_holds h WHERE h.machine_id=m.id AND h.resolved_at IS NULL)
          AND COALESCE((to_jsonb(m)->>'scheduling_enabled')::boolean,true)
      )
      SELECT op.id::text,NULLIF(btrim(op.machine_family_code),'') AS family,frozen.operation_type,
        CASE WHEN op.poste_id IS NOT NULL AND (p.id IS NULL OR NOT p.is_active OR p.archived_at IS NOT NULL) THEN '{}'::text[]
          WHEN frozen.operation_type IN ('DECOUPE','ASSEMBLAGE','CONTROLE','LAVAGE','EMBALLAGE','AUTRE')
          AND p.id IS NOT NULL AND p.is_active AND p.archived_at IS NULL AND p.machine_id IS NULL AND op.machine_id IS NULL
          THEN ARRAY['poste:'||p.id::text]
          ELSE COALESCE(array_agg(r.id ORDER BY r.id) FILTER(WHERE r.id IS NOT NULL),'{}'::text[]) END AS eligible
      FROM public.of_operations op
      JOIN public.ordres_fabrication o ON o.id=op.of_id
      LEFT JOIN LATERAL (SELECT value->>'type_operation' AS operation_type
        FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]'::jsonb))
        WHERE value->>'phase'=op.phase::text LIMIT 1) frozen ON true
      LEFT JOIN public.postes p ON p.id=COALESCE(op.poste_id,($2::jsonb->>frozen.operation_type)::uuid)
      LEFT JOIN qualified_resources r
        ON r.family=upper(NULLIF(btrim(op.machine_family_code),''))
      WHERE op.id=ANY($1::uuid[]) GROUP BY op.id,p.id,frozen.operation_type`,[operationIds,JSON.stringify(defaultPostes)]);
  return qualifications;
}
