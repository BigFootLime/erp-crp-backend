import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { PlanningReferenceOfListQuery } from "../validators/planning-references.validators";

export type PlanningOfListItem = {
  id: number; numero: string; affaire_id: number | null; commande_id: number | null; parent_of_id: number | null; root_of_id: number | null; generation_batch_id: string | null; generation_level: number; source_bom_line_id: string | null; structure_path: string | null; quantity_per_parent: number; quantity_cumulative: number; client_id: string | null; client_company_name: string | null;
  piece_technique_id: string; piece_code: string; piece_designation: string;
  quantite_lancee: number; quantite_bonne: number; quantite_rebut: number;
  statut: string; priority: string; date_lancement_prevue: string | null; date_fin_prevue: string | null;
  updated_at: string; total_ops: number; done_ops: number;
};
export type PlanningOfOperation = {
  id: string; phase: number; designation: string; poste_id: string | null; poste_code: string | null;
  poste_label: string | null; machine_id: string | null; machine_code: string | null; machine_name: string | null;
  planned_duration_minutes: number; status: string; started_at: string | null; ended_at: string | null; updated_at: string;
};
export type PlanningOfDetail = PlanningOfListItem & {
  piece_technique_version_id: string | null;
  technical_readiness: string; date_lancement_reelle: string | null; date_fin_reelle: string | null;
  operations: PlanningOfOperation[];
};

function mapList(row: Omit<PlanningOfListItem, "id" | "quantite_lancee" | "quantite_bonne" | "quantite_rebut" | "total_ops" | "done_ops"> & {
  id: string; affaire_id: number | null; commande_id: number | null; parent_of_id: number | null; root_of_id: number | null; generation_batch_id: string | null; generation_level: number; source_bom_line_id: string | null; structure_path: string | null; quantity_per_parent: number; quantity_cumulative: number; quantite_lancee: number; quantite_bonne: number; quantite_rebut: number; total_ops: number; done_ops: number;
}): PlanningOfListItem {
  return { ...row, id: Number(row.id), affaire_id: row.affaire_id === null ? null : Number(row.affaire_id), commande_id: row.commande_id === null ? null : Number(row.commande_id), parent_of_id: row.parent_of_id === null ? null : Number(row.parent_of_id), root_of_id: row.root_of_id === null ? null : Number(row.root_of_id), generation_level: Number(row.generation_level), quantity_per_parent: Number(row.quantity_per_parent), quantity_cumulative: Number(row.quantity_cumulative), quantite_lancee: Number(row.quantite_lancee), quantite_bonne: Number(row.quantite_bonne),
    quantite_rebut: Number(row.quantite_rebut), total_ops: Number(row.total_ops), done_ops: Number(row.done_ops) };
}

export async function repoListPlanningReferenceOfs(query: PlanningReferenceOfListQuery): Promise<{ items: PlanningOfListItem[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (value: unknown) => { values.push(value); return '$' + values.length; };
  if (query.q) {
    const p = push('%' + query.q + '%');
    where.push(`(o.numero ILIKE ${p} OR pt.code_piece ILIKE ${p} OR pt.designation ILIKE ${p} OR COALESCE(c.company_name, '') ILIKE ${p})`);
  }
  if (query.statut) where.push(`o.statut = ${push(query.statut)}::of_status`);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const count = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM public.ordres_fabrication o JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id
      LEFT JOIN public.clients c ON c.client_id=o.client_id ${whereSql}`, values,
  );
  const limit = push(query.pageSize);
  const offset = push((query.page - 1) * query.pageSize);
  const result = await pool.query<Parameters<typeof mapList>[0]>(
    `SELECT o.id::text AS id,o.numero,o.affaire_id::bigint::int AS affaire_id,o.commande_id::bigint::int AS commande_id,o.parent_of_id::bigint::int AS parent_of_id,o.root_of_id::bigint::int AS root_of_id,o.generation_batch_id::text AS generation_batch_id,o.generation_level::int AS generation_level,o.source_bom_line_id::text AS source_bom_line_id,o.structure_path,o.quantity_per_parent::float8 AS quantity_per_parent,o.quantity_cumulative::float8 AS quantity_cumulative,o.client_id,c.company_name AS client_company_name,
      o.piece_technique_id::text AS piece_technique_id,pt.code_piece,pt.designation AS piece_designation,
      o.quantite_lancee::float8 AS quantite_lancee,o.quantite_bonne::float8 AS quantite_bonne,o.quantite_rebut::float8 AS quantite_rebut,
      o.statut::text AS statut,o.priority::text AS priority,o.date_lancement_prevue::text AS date_lancement_prevue,
      o.date_fin_prevue::text AS date_fin_prevue,o.updated_at::text AS updated_at,
      COALESCE(ops.total_ops,0)::int AS total_ops,COALESCE(ops.done_ops,0)::int AS done_ops
      FROM public.ordres_fabrication o JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id
      LEFT JOIN public.clients c ON c.client_id=o.client_id
      LEFT JOIN LATERAL (SELECT count(*) AS total_ops,count(*) FILTER (WHERE status='DONE') AS done_ops FROM public.of_operations op WHERE op.of_id=o.id) ops ON true
      ${whereSql} ORDER BY o.date_fin_prevue ASC NULLS LAST,o.id DESC LIMIT ${limit} OFFSET ${offset}`,
    values,
  );
  return { items: result.rows.map(mapList), total: count.rows[0]?.total ?? 0 };
}

export async function repoGetPlanningReferenceOf(id: number): Promise<PlanningOfDetail | null> {
  const header = await pool.query<Omit<PlanningOfDetail, "operations" | "id" | "quantite_lancee" | "quantite_bonne" | "quantite_rebut" | "total_ops" | "done_ops"> & {
    id: string; affaire_id: number | null; commande_id: number | null; parent_of_id: number | null; root_of_id: number | null; generation_batch_id: string | null; generation_level: number; source_bom_line_id: string | null; structure_path: string | null; quantity_per_parent: number; quantity_cumulative: number; quantite_lancee: number; quantite_bonne: number; quantite_rebut: number; total_ops: number; done_ops: number;
  }>(
    `SELECT o.id::text AS id,o.numero,o.affaire_id::bigint::int AS affaire_id,o.commande_id::bigint::int AS commande_id,o.parent_of_id::bigint::int AS parent_of_id,o.root_of_id::bigint::int AS root_of_id,o.generation_batch_id::text AS generation_batch_id,o.generation_level::int AS generation_level,o.source_bom_line_id::text AS source_bom_line_id,o.structure_path,o.quantity_per_parent::float8 AS quantity_per_parent,o.quantity_cumulative::float8 AS quantity_cumulative,o.client_id,c.company_name AS client_company_name,
      o.piece_technique_id::text AS piece_technique_id,pt.code_piece,pt.designation AS piece_designation,
      o.quantite_lancee::float8 AS quantite_lancee,o.quantite_bonne::float8 AS quantite_bonne,o.quantite_rebut::float8 AS quantite_rebut,
      o.statut::text AS statut,o.priority::text AS priority,o.date_lancement_prevue::text AS date_lancement_prevue,o.date_fin_prevue::text AS date_fin_prevue,
      o.updated_at::text AS updated_at,COALESCE(ops.total_ops,0)::int AS total_ops,COALESCE(ops.done_ops,0)::int AS done_ops,
      o.piece_technique_version_id::text AS piece_technique_version_id,
      o.technical_readiness,o.date_lancement_reelle::text AS date_lancement_reelle,o.date_fin_reelle::text AS date_fin_reelle
      FROM public.ordres_fabrication o JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id
      LEFT JOIN public.clients c ON c.client_id=o.client_id
      LEFT JOIN LATERAL (SELECT count(*) AS total_ops,count(*) FILTER (WHERE status='DONE') AS done_ops FROM public.of_operations op WHERE op.of_id=o.id) ops ON true
      WHERE o.id=$1::bigint LIMIT 1`, [id],
  );
  const base = header.rows[0];
  if (!base) return null;
  const operations = await pool.query<PlanningOfOperation>(
    `SELECT op.id::text AS id,op.phase::int AS phase,op.designation,op.poste_id::text AS poste_id,p.code AS poste_code,p.label AS poste_label,
      op.machine_id::text AS machine_id,m.code AS machine_code,m.name AS machine_name,
      GREATEST(0,round((COALESCE(op.temps_total_planned,0)::numeric)*60))::int AS planned_duration_minutes,
      op.status::text AS status,op.started_at::text AS started_at,op.ended_at::text AS ended_at,op.updated_at::text AS updated_at
      FROM public.of_operations op LEFT JOIN public.postes p ON p.id=op.poste_id LEFT JOIN public.machines m ON m.id=op.machine_id
      WHERE op.of_id=$1::bigint ORDER BY op.phase ASC,op.id ASC`, [id],
  );
  return { ...mapList(base), piece_technique_version_id: base.piece_technique_version_id, technical_readiness: base.technical_readiness,
    date_lancement_reelle: base.date_lancement_reelle, date_fin_reelle: base.date_fin_reelle, operations: operations.rows };
}
