import pool from "../../../config/database";
import type { ListProgrammationsQueryDTO } from "../validators/programmation.validators";
import type { Paginated, ProgrammationTaskListItem } from "../types/programmation.types";

function isUndefinedTableError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "42P01";
}

export async function repoListProgrammations(filters: ListProgrammationsQueryDTO): Promise<Paginated<ProgrammationTaskListItem>> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (!filters.include_archived) {
    where.push("pr.archived_at IS NULL");
  }

  const fromP = push(filters.from);
  const toP = push(filters.to);

  // Date overlap (range end treated as exclusive, consistent with the frontend).
  where.push(
    `daterange(pr.date_commencement, (pr.date_fin + 1), '[)') && daterange(${fromP}::timestamptz::date, ${toP}::timestamptz::date, '[)')`
  );

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const countRes = await pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM public.programmations pr ${whereSql}`,
      values
    );
    const total = countRes.rows[0]?.total ?? 0;

    type Row = {
      id: string;
      piece_technique_id: string;
      piece_code: string;
      piece_designation: string;
      client_id: string | null;
      client_company_name: string | null;
      plan_reference: string | null;
      date_commencement: string;
      date_fin: string;
      programmer_user_id: number | null;
      programmer_name: string | null;
      created_at: string;
      updated_at: string;
      archived_at: string | null;
    };

    const dataRes = await pool.query<Row>(
      `
        SELECT
          pr.id::text AS id,
          pr.piece_technique_id::text AS piece_technique_id,
          pt.code_piece AS piece_code,
          pt.designation AS piece_designation,
          pt.client_id AS client_id,
          COALESCE(c.company_name, pt.client_name) AS client_company_name,
          pr.plan_reference,
          pr.date_commencement::text AS date_commencement,
          pr.date_fin::text AS date_fin,
          pr.programmer_user_id,
          u.username AS programmer_name,
          pr.created_at::text AS created_at,
          pr.updated_at::text AS updated_at,
          pr.archived_at::text AS archived_at
        FROM public.programmations pr
        JOIN public.pieces_techniques pt
          ON pt.id = pr.piece_technique_id
         AND pt.deleted_at IS NULL
        LEFT JOIN public.clients c ON c.client_id = pt.client_id
        LEFT JOIN public.users u ON u.id = pr.programmer_user_id
        ${whereSql}
        ORDER BY pr.date_commencement ASC, pr.id ASC
      `,
      values
    );

    const items: ProgrammationTaskListItem[] = dataRes.rows.map((r) => ({
      id: r.id,
      piece_technique_id: r.piece_technique_id,
      piece_code: r.piece_code,
      piece_designation: r.piece_designation,
      client_id: r.client_id,
      client_company_name: r.client_company_name,
      plan_reference: r.plan_reference,
      date_commencement: r.date_commencement,
      date_fin: r.date_fin,
      programmer_user_id: r.programmer_user_id,
      programmer_name: r.programmer_name,
      created_at: r.created_at,
      updated_at: r.updated_at,
      archived_at: r.archived_at,
    }));

    return { items, total };
  } catch (err) {
    if (isUndefinedTableError(err)) {
      return { items: [], total: 0 };
    }
    throw err;
  }
}
