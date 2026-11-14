import type { Pool } from "pg"
import type {
  BonLivraisonListItem,
  BonLivraisonListSummary,
  BonLivraisonStatut,
  Paginated,
} from "../types/livraisons.types"
import type { ListLivraisonsQueryDTO } from "../validators/livraisons.validators"

function sortColumn(sortBy: ListLivraisonsQueryDTO["sortBy"]) {
  switch (sortBy) {
    case "numero":
      return "bl.numero"
    case "statut":
      return "bl.statut"
    case "updated_at":
      return "bl.updated_at"
    case "date_creation":
    default:
      return "bl.date_creation"
  }
}

function sortDirection(sortDir: ListLivraisonsQueryDTO["sortDir"]) {
  return sortDir === "asc" ? "ASC" : "DESC"
}

type ListWhere = { whereSql: string; values: unknown[] }
function buildListWhere(filters: ListLivraisonsQueryDTO): ListWhere {
  const where: string[] = []
  const values: unknown[] = []
  const push = (v: unknown) => {
    values.push(v)
    return `$${values.length}`
  }

  if (filters.q && filters.q.trim().length > 0) {
    const p = push(`%${filters.q.trim()}%`)
    where.push(`(
      bl.numero ILIKE ${p}
      OR c.company_name ILIKE ${p}
      OR (cc.numero IS NOT NULL AND cc.numero ILIKE ${p})
      OR EXISTS (
        SELECT 1
        FROM public.bon_livraison_ligne scope_line
        JOIN public.bon_livraison_ligne_allocations scope_bla
          ON scope_bla.bon_livraison_ligne_id = scope_line.id
        JOIN public.commande_ligne_affaire_allocation scope_allocation
          ON scope_allocation.id = scope_bla.commande_ligne_affaire_allocation_id
        JOIN public.commande_client scope_commande
          ON scope_commande.id = scope_allocation.commande_id
        WHERE scope_line.bon_livraison_id = bl.id
          AND scope_commande.numero ILIKE ${p}
      )
    )`)
  }

  if (filters.client_id && filters.client_id.trim().length > 0) {
    const p = push(filters.client_id.trim())
    where.push(`bl.client_id = ${p}`)
  }

  if (filters.commande_id) {
    const p = push(filters.commande_id)
    where.push(`(
      bl.commande_id = ${p}::bigint
      OR EXISTS (
        SELECT 1
        FROM public.bon_livraison_ligne scope_line
        JOIN public.bon_livraison_ligne_allocations scope_bla
          ON scope_bla.bon_livraison_ligne_id = scope_line.id
        JOIN public.commande_ligne_affaire_allocation scope_allocation
          ON scope_allocation.id = scope_bla.commande_ligne_affaire_allocation_id
        WHERE scope_line.bon_livraison_id = bl.id
          AND scope_allocation.commande_id = ${p}::bigint
      )
    )`)
  }

  if (filters.statut) {
    const p = push(filters.statut)
    where.push(`bl.statut = ${p}`)
  }

  if (filters.from && filters.from.trim().length > 0) {
    const p = push(filters.from.trim())
    where.push(`bl.date_creation >= ${p}::date`)
  }

  if (filters.to && filters.to.trim().length > 0) {
    const p = push(filters.to.trim())
    where.push(`bl.date_creation <= ${p}::date`)
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  }
}

/** Owns the paginated delivery list read model, including allocation-derived scopes. */
export function createDeliveryListReadRepository(deps: {
  pool: Pick<Pool, "query">
  toInt: (value: unknown, label?: string) => number
}) {
  const { pool, toInt } = deps

  async function repoListLivraisons(
    filters: ListLivraisonsQueryDTO
  ): Promise<Paginated<BonLivraisonListItem> & { summary: BonLivraisonListSummary }> {
    const page = filters.page ?? 1
    const pageSize = filters.pageSize ?? 50
    const offset = (page - 1) * pageSize

    const { whereSql, values } = buildListWhere(filters)
    const orderBy = sortColumn(filters.sortBy)
    const orderDir = sortDirection(filters.sortDir)

    const countSql = `
    SELECT COUNT(*)::int AS total
    FROM bon_livraison bl
    JOIN clients c ON c.client_id = bl.client_id
    LEFT JOIN commande_client cc ON cc.id = bl.commande_id
    ${whereSql}
  `
    const countRes = await pool.query<{ total: number }>(countSql, values)
    const total = countRes.rows[0]?.total ?? 0
    const summaryRes = await pool.query<BonLivraisonListSummary>(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE bl.statut = 'DRAFT')::int AS draft,
        COUNT(*) FILTER (WHERE bl.statut = 'READY')::int AS ready,
        COUNT(*) FILTER (WHERE bl.statut = 'SHIPPED')::int AS shipped,
        COUNT(*) FILTER (WHERE bl.statut = 'DELIVERED')::int AS delivered,
        COUNT(*) FILTER (WHERE bl.statut = 'CANCELLED')::int AS cancelled
      FROM public.bon_livraison bl
      JOIN public.clients c ON c.client_id = bl.client_id
      LEFT JOIN public.commande_client cc ON cc.id = bl.commande_id
      ${whereSql}
    `,
      values
    )
    const summary = summaryRes.rows[0] ?? {
      total: 0,
      draft: 0,
      ready: 0,
      shipped: 0,
      delivered: 0,
      cancelled: 0,
    }

    type Row = {
      id: string
      numero: string
      statut: BonLivraisonStatut
      client_id: string
      client_company_name: string
      commande_id: string | null
      commande_numero: string | null
      commande_numeros: string[]
      affaire_id: string | null
      affaire_reference: string | null
      affaire_references: string[]
      date_creation: string
      date_expedition: string | null
      date_livraison: string | null
      transporteur: string | null
      tracking_number: string | null
      updated_at: string
    }

    const dataSql = `
    SELECT
      bl.id::text AS id,
      bl.numero,
      bl.statut,
      bl.client_id,
      c.company_name AS client_company_name,
      bl.commande_id::text AS commande_id,
      cc.numero AS commande_numero,
      ARRAY(
        SELECT reference
        FROM (
          SELECT DISTINCT scope_commande.numero AS reference
          FROM public.bon_livraison_ligne scope_line
          JOIN public.bon_livraison_ligne_allocations scope_bla
            ON scope_bla.bon_livraison_ligne_id = scope_line.id
          JOIN public.commande_ligne_affaire_allocation scope_allocation
            ON scope_allocation.id = scope_bla.commande_ligne_affaire_allocation_id
          JOIN public.commande_client scope_commande
            ON scope_commande.id = scope_allocation.commande_id
          WHERE scope_line.bon_livraison_id = bl.id
          UNION
          SELECT cc.numero WHERE cc.numero IS NOT NULL
        ) commande_scope
        ORDER BY reference
      ) AS commande_numeros,
      bl.affaire_id::text AS affaire_id,
      a.reference AS affaire_reference,
      ARRAY(
        SELECT reference
        FROM (
          SELECT DISTINCT scope_affaire.reference
          FROM public.bon_livraison_ligne scope_line
          JOIN public.bon_livraison_ligne_allocations scope_bla
            ON scope_bla.bon_livraison_ligne_id = scope_line.id
          JOIN public.commande_ligne_affaire_allocation scope_allocation
            ON scope_allocation.id = scope_bla.commande_ligne_affaire_allocation_id
          JOIN public.affaire scope_affaire
            ON scope_affaire.id = scope_allocation.livraison_affaire_id
          WHERE scope_line.bon_livraison_id = bl.id
          UNION
          SELECT a.reference WHERE a.reference IS NOT NULL
        ) affaire_scope
        ORDER BY reference
      ) AS affaire_references,
      bl.date_creation::text AS date_creation,
      bl.date_expedition::text AS date_expedition,
      bl.date_livraison::text AS date_livraison,
      bl.transporteur,
      bl.tracking_number,
      bl.updated_at::text AS updated_at
    FROM bon_livraison bl
    JOIN clients c ON c.client_id = bl.client_id
    LEFT JOIN commande_client cc ON cc.id = bl.commande_id
    LEFT JOIN affaire a ON a.id = bl.affaire_id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `
    const dataRes = await pool.query<Row>(dataSql, [...values, pageSize, offset])

    const items: BonLivraisonListItem[] = dataRes.rows.map((r: Row) => ({
      id: r.id,
      numero: r.numero,
      statut: r.statut,
      client: { client_id: r.client_id, company_name: r.client_company_name },
      commande: r.commande_id && r.commande_numero ? { id: toInt(r.commande_id, "bon_livraison.commande_id"), numero: r.commande_numero } : null,
      commande_numeros: r.commande_numeros,
      affaire: r.affaire_id && r.affaire_reference ? { id: toInt(r.affaire_id, "bon_livraison.affaire_id"), reference: r.affaire_reference } : null,
      affaire_references: r.affaire_references,
      date_creation: r.date_creation,
      date_expedition: r.date_expedition,
      date_livraison: r.date_livraison,
      transporteur: r.transporteur,
      tracking_number: r.tracking_number,
      updated_at: r.updated_at,
    }))

    return { items, total, summary }
  }

  return { repoListLivraisons }
}
