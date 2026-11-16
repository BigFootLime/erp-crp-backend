import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { Paginated, StockEmplacementListItem, StockMagasinDetail, StockMagasinKpis, StockMagasinListItem } from "../types/stock.types";
import type { CreateEmplacementBodyDTO, CreateMagasinBodyDTO, ListEmplacementsQueryDTO, ListMagasinsQueryDTO, UpdateEmplacementBodyDTO, UpdateMagasinBodyDTO } from "../validators/stock.validators";
import { normalizeLikeQuery, sortDirection } from "./stock-query.repository";
import { insertAuditLog, isPgUniqueViolation, type AuditContext } from "./stock-persistence.repository";
function magasinSortColumn(sortBy: ListMagasinsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "m.created_at";
    case "code":
      return "COALESCE(m.code, m.code_magasin)";
    case "name":
      return "COALESCE(m.name, m.libelle)";
    case "updated_at":
    default:
      return "m.updated_at";
  }
}
function emplacementSortColumn(sortBy: ListEmplacementsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "e.created_at";
    case "code":
      return "e.code";
    case "updated_at":
    default:
      return "e.updated_at";
  }
}

export async function repoListMagasins(filters: ListMagasinsQueryDTO): Promise<Paginated<StockMagasinListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(
      `(
        COALESCE(m.code, m.code_magasin) ILIKE ${p}
        OR COALESCE(m.name, m.libelle) ILIKE ${p}
      )`
    );
  }
  if (filters.is_active !== undefined) where.push(`m.is_active = ${push(filters.is_active)}`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = magasinSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.magasins m ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      m.id::text AS id,
      COALESCE(m.code, m.code_magasin)::text AS code,
      COALESCE(m.name, m.libelle)::text AS name,
      m.is_active,
      COALESCE(m.updated_at, now())::text AS updated_at,
      COALESCE(m.created_at, now())::text AS created_at,
      COALESCE(ec.emplacements_count, 0)::int AS emplacements_count,
      COALESCE(ec.scrap_emplacements_count, 0)::int AS scrap_emplacements_count
    FROM public.magasins m
    LEFT JOIN (
      SELECT
        magasin_id,
        COUNT(*)::int AS emplacements_count,
        COUNT(*) FILTER (WHERE is_scrap)::int AS scrap_emplacements_count
      FROM public.emplacements
      GROUP BY magasin_id
    ) ec ON ec.magasin_id = m.id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockMagasinListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoGetMagasin(id: string): Promise<StockMagasinDetail | null> {
  const m = await db.query<StockMagasinDetail["magasin"]>(
    `
      SELECT
        id::text AS id,
        COALESCE(code, code_magasin)::text AS code,
        COALESCE(name, libelle)::text AS name,
        is_active,
        notes,
        COALESCE(updated_at, now())::text AS updated_at,
        COALESCE(created_at, now())::text AS created_at
      FROM public.magasins
      WHERE id = $1::uuid
    `,
    [id]
  );

  const magasin = m.rows[0] ?? null;
  if (!magasin) return null;

  const e = await db.query<StockEmplacementListItem>(
    `
      SELECT
        e.id::int AS id,
        e.magasin_id::text AS magasin_id,
        COALESCE(m.code, m.code_magasin)::text AS magasin_code,
        COALESCE(m.name, m.libelle)::text AS magasin_name,
        e.code,
        e.name,
        e.is_scrap,
        e.is_active,
        e.location_type,
        e.allow_inbound,
        e.allow_outbound,
        e.restrictions,
        e.updated_at::text AS updated_at,
        e.created_at::text AS created_at
      FROM public.emplacements e
      JOIN public.magasins m ON m.id = e.magasin_id
      WHERE e.magasin_id = $1::uuid
      ORDER BY e.code ASC, e.id ASC
    `,
    [id]
  );

  return { magasin, emplacements: e.rows };
}

export async function repoGetMagasinsKpis(): Promise<StockMagasinKpis> {
  const res = await db.query<StockMagasinKpis>(
    `
      SELECT
        (SELECT COUNT(*) FROM public.magasins)::int AS magasins_total,
        (SELECT COUNT(*) FROM public.magasins WHERE is_active)::int AS magasins_active,
        (SELECT COUNT(*) FROM public.emplacements)::int AS emplacements_total,
        (SELECT COUNT(*) FROM public.emplacements WHERE is_scrap)::int AS emplacements_scrap
    `
  );
  return (
    res.rows[0] ?? {
      magasins_total: 0,
      magasins_active: 0,
      emplacements_total: 0,
      emplacements_scrap: 0,
    }
  );
}

export async function repoCreateMagasin(body: CreateMagasinBodyDTO, audit: AuditContext): Promise<StockMagasinDetail["magasin"]> {
  try {
    const res = await db.query<{ id: string }>(
      `
        INSERT INTO public.magasins (
          code_magasin, libelle,
          code, name,
          actif, is_active,
          notes,
          created_by, updated_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
        RETURNING id::text AS id
      `,
      [
        body.code,
        body.name,
        body.code,
        body.name,
        body.is_active,
        body.is_active,
        body.notes ?? null,
        audit.user_id,
      ]
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("Failed to create magasin");

    await insertAuditLog(db, audit, {
      action: "stock.magasins.create",
      entity_type: "magasins",
      entity_id: id,
      details: { code: body.code, name: body.name },
    });

    const out = await repoGetMagasin(id);
    if (!out) throw new Error("Failed to read created magasin");
    return out.magasin;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Magasin code already exists");
    }
    throw err;
  }
}

export async function repoUpdateMagasin(
  id: string,
  patch: UpdateMagasinBodyDTO,
  audit: AuditContext
): Promise<StockMagasinDetail["magasin"] | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.code !== undefined) {
    sets.push(`code = ${push(patch.code)}`);
    sets.push(`code_magasin = ${push(patch.code)}`);
  }
  if (patch.name !== undefined) {
    sets.push(`name = ${push(patch.name)}`);
    sets.push(`libelle = ${push(patch.name)}`);
  }
  if (patch.is_active !== undefined) {
    sets.push(`is_active = ${push(patch.is_active)}`);
    sets.push(`actif = ${push(patch.is_active)}`);
  }
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);
  sets.push(`updated_at = now()`);
  sets.push(`updated_by = ${push(audit.user_id)}`);

  try {
    const res = await db.query<{ id: string }>(
      `UPDATE public.magasins SET ${sets.join(", ")} WHERE id = ${push(id)}::uuid RETURNING id::text AS id`,
      values
    );
    if (!res.rows[0]?.id) return null;

    await insertAuditLog(db, audit, {
      action: "stock.magasins.update",
      entity_type: "magasins",
      entity_id: id,
      details: { patch },
    });

    const out = await repoGetMagasin(id);
    return out?.magasin ?? null;
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Magasin code already exists");
    }
    throw err;
  }
}

export async function repoDeactivateMagasin(id: string, audit: AuditContext): Promise<StockMagasinDetail["magasin"] | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.magasins WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    if (!exists.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    const blocking = await client.query<{ key: string; value_text: string }>(
      `
        SELECT s.key, s.value_text
        FROM public.erp_settings s
        WHERE s.key IN ('stock.default_shipping_location','stock.default_receipt_location')
          AND s.value_text IS NOT NULL
          AND s.value_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND EXISTS (
            SELECT 1
            FROM public.emplacements e
            WHERE e.magasin_id = $1::uuid
              AND e.location_id = s.value_text::uuid
          )
        LIMIT 1
      `,
      [id]
    );

    const blocked = blocking.rows[0] ?? null;
    if (blocked) {
      throw new HttpError(
        409,
        "MAGASIN_DEFAULT_LOCATION",
        "Impossible de desactiver ce magasin : il contient l'emplacement utilise comme emplacement par defaut dans les parametres."
      );
    }

    await client.query(
      `
        UPDATE public.magasins
        SET
          is_active = false,
          actif = false,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.magasins.deactivate",
      entity_type: "magasins",
      entity_id: id,
      details: null,
    });

    await client.query("COMMIT");
    const out = await repoGetMagasin(id);
    return out?.magasin ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
export async function repoActivateMagasin(id: string, audit: AuditContext): Promise<StockMagasinDetail["magasin"] | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exists = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.magasins WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    if (!exists.rows[0]?.id) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `
        UPDATE public.magasins
        SET
          is_active = true,
          actif = true,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.magasins.activate",
      entity_type: "magasins",
      entity_id: id,
      details: null,
    });

    await client.query("COMMIT");
    const out = await repoGetMagasin(id);
    return out?.magasin ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoListEmplacements(filters: ListEmplacementsQueryDTO): Promise<Paginated<StockEmplacementListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.magasin_id) where.push(`e.magasin_id = ${push(filters.magasin_id)}::uuid`);
  if (filters.is_active !== undefined) where.push(`e.is_active = ${push(filters.is_active)}`);
  if (filters.is_scrap !== undefined) where.push(`e.is_scrap = ${push(filters.is_scrap)}`);
  if (filters.location_type) where.push(`e.location_type = ${push(filters.location_type)}`);
  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(
      `(
        e.code ILIKE ${p}
        OR COALESCE(e.name, '') ILIKE ${p}
        OR COALESCE(m.code, m.code_magasin) ILIKE ${p}
        OR COALESCE(m.name, m.libelle) ILIKE ${p}
      )`
    );
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = emplacementSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.emplacements e JOIN public.magasins m ON m.id = e.magasin_id ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      e.id::int AS id,
      e.magasin_id::text AS magasin_id,
      COALESCE(m.code, m.code_magasin)::text AS magasin_code,
      COALESCE(m.name, m.libelle)::text AS magasin_name,
      e.code,
      e.name,
      e.is_scrap,
      e.is_active,
      e.location_type,
      e.allow_inbound,
      e.allow_outbound,
      e.restrictions,
      e.updated_at::text AS updated_at,
      e.created_at::text AS created_at
    FROM public.emplacements e
    JOIN public.magasins m ON m.id = e.magasin_id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;
  const rows = await db.query<StockEmplacementListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}

export async function repoCreateEmplacement(
  magasinId: string,
  body: CreateEmplacementBodyDTO,
  audit: AuditContext
): Promise<StockEmplacementListItem | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const mag = await client.query<{ ok: number; code: string; name: string; warehouse_id: string | null }>(
      `
        SELECT
          1::int AS ok,
          COALESCE(code, code_magasin)::text AS code,
          COALESCE(name, libelle)::text AS name,
          warehouse_id::text AS warehouse_id
        FROM public.magasins
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [magasinId]
    );
    const base = mag.rows[0] ?? null;
    if (!base?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const ins = await client.query<{ id: number }>(
      `
        INSERT INTO public.emplacements (
          magasin_id,
          code,
          name,
          is_scrap,
          is_active,
          location_type,
          allow_inbound,
          allow_outbound,
          restrictions,
          notes,
          created_by,
          updated_by
        )
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$11)
        RETURNING id::int AS id
      `,
      [
        magasinId,
        body.code,
        body.name ?? null,
        body.is_scrap,
        body.is_active,
        body.location_type,
        body.allow_inbound,
        body.allow_outbound,
        JSON.stringify(body.restrictions),
        body.notes ?? null,
        audit.user_id,
      ]
    );
    const id = ins.rows[0]?.id;
    if (!id) throw new Error("Failed to create emplacement");

    // Ensure an emplacement is mapped to a stock location (required by movements).
    // Legacy databases may not have triggers to maintain this mapping.
    const warehouseCode = base.code;
    const warehouseName = base.name;

    let warehouseId = base.warehouse_id ?? (
      await client.query<{ id: string }>(
        `SELECT id::text AS id FROM public.warehouses WHERE code = $1::citext LIMIT 1`,
        [warehouseCode]
      )
    ).rows[0]?.id;

    if (!warehouseId) {
      try {
        warehouseId = (
          await client.query<{ id: string }>(
            `INSERT INTO public.warehouses (code, name) VALUES ($1::citext,$2) RETURNING id::text AS id`,
            [warehouseCode, warehouseName]
          )
        ).rows[0]?.id;
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          warehouseId = (
            await client.query<{ id: string }>(
              `SELECT id::text AS id FROM public.warehouses WHERE code = $1::citext LIMIT 1`,
              [warehouseCode]
            )
          ).rows[0]?.id;
        } else {
          throw err;
        }
      }
    }

    if (!warehouseId) throw new Error("Failed to resolve warehouse for emplacement");

    await client.query(
      `UPDATE public.magasins SET warehouse_id=$2::uuid, updated_at=now(), updated_by=$3
       WHERE id=$1::uuid AND warehouse_id IS NULL`,
      [magasinId, warehouseId, audit.user_id]
    );

    const locationCode = `${warehouseCode}-${body.code}`;
    let locationId = (
      await client.query<{ id: string }>(
        `SELECT id::text AS id FROM public.locations WHERE warehouse_id = $1::uuid AND code = $2::citext LIMIT 1`,
        [warehouseId, locationCode]
      )
    ).rows[0]?.id;

    if (!locationId) {
      try {
        locationId = (
          await client.query<{ id: string }>(
            `
              INSERT INTO public.locations (warehouse_id, code, description)
              VALUES ($1::uuid,$2::citext,$3)
              RETURNING id::text AS id
            `,
            [warehouseId, locationCode, `Emplacement ${body.code}`]
          )
        ).rows[0]?.id;
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          locationId = (
            await client.query<{ id: string }>(
              `SELECT id::text AS id FROM public.locations WHERE warehouse_id = $1::uuid AND code = $2::citext LIMIT 1`,
              [warehouseId, locationCode]
            )
          ).rows[0]?.id;
        } else {
          throw err;
        }
      }
    }

    if (!locationId) throw new Error("Failed to resolve location for emplacement");

    await client.query(
      `UPDATE public.emplacements SET location_id = $2::uuid, updated_at = now(), updated_by = $3 WHERE id = $1::bigint`,
      [id, locationId, audit.user_id]
    );

    await insertAuditLog(client, audit, {
      action: "stock.emplacements.create",
      entity_type: "emplacements",
      entity_id: String(id),
      details: {
        magasin_id: magasinId,
        magasin_code: base.code,
        code: body.code,
        is_scrap: body.is_scrap,
      },
    });

    await client.query("COMMIT");

    const out = await db.query<StockEmplacementListItem>(
      `
        SELECT
          e.id::int AS id,
          e.magasin_id::text AS magasin_id,
          COALESCE(m.code, m.code_magasin)::text AS magasin_code,
          COALESCE(m.name, m.libelle)::text AS magasin_name,
          e.code,
          e.name,
          e.is_scrap,
          e.is_active,
          e.location_type,
          e.allow_inbound,
          e.allow_outbound,
          e.restrictions,
          e.updated_at::text AS updated_at,
          e.created_at::text AS created_at
        FROM public.emplacements e
        JOIN public.magasins m ON m.id = e.magasin_id
        WHERE e.id = $1::bigint
      `,
      [id]
    );
    return out.rows[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Emplacement code already exists in this magasin");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoUpdateEmplacement(
  id: number,
  patch: UpdateEmplacementBodyDTO,
  audit: AuditContext
): Promise<StockEmplacementListItem | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{
      is_scrap: boolean;
      location_type: StockEmplacementListItem["location_type"];
      allow_outbound: boolean;
    }>(
      `
        SELECT is_scrap, location_type, allow_outbound
        FROM public.emplacements
        WHERE id = $1::bigint
        FOR UPDATE
      `,
      [id]
    );
    const row = current.rows[0] ?? null;
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    const nextIsScrap = patch.is_scrap ?? row.is_scrap;
    const nextLocationType = patch.location_type ?? row.location_type;
    const nextAllowOutbound = patch.allow_outbound ?? row.allow_outbound;
    if (nextIsScrap !== (nextLocationType === "SCRAP")) {
      throw new HttpError(
        409,
        "LOCATION_TYPE_INCONSISTENT",
        "SCRAP location type and scrap flag must be changed together"
      );
    }
    if (nextLocationType === "SCRAP" && nextAllowOutbound) {
      throw new HttpError(409, "LOCATION_TYPE_INCONSISTENT", "A SCRAP location cannot provide stock");
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };

    if (patch.code !== undefined) sets.push(`code = ${push(patch.code)}`);
    if (patch.name !== undefined) sets.push(`name = ${push(patch.name)}`);
    if (patch.is_scrap !== undefined) sets.push(`is_scrap = ${push(patch.is_scrap)}`);
    if (patch.is_active !== undefined) sets.push(`is_active = ${push(patch.is_active)}`);
    if (patch.location_type !== undefined) sets.push(`location_type = ${push(patch.location_type)}`);
    if (patch.allow_inbound !== undefined) sets.push(`allow_inbound = ${push(patch.allow_inbound)}`);
    if (patch.allow_outbound !== undefined) sets.push(`allow_outbound = ${push(patch.allow_outbound)}`);
    if (patch.restrictions !== undefined) {
      sets.push(`restrictions = ${push(JSON.stringify(patch.restrictions))}::jsonb`);
    }
    if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);
    sets.push(`updated_at = now()`);
    sets.push(`updated_by = ${push(audit.user_id)}`);

    await client.query(
      `UPDATE public.emplacements SET ${sets.join(", ")} WHERE id = ${push(id)}::bigint`,
      values
    );

    await insertAuditLog(client, audit, {
      action: "stock.emplacements.update",
      entity_type: "emplacements",
      entity_id: String(id),
      details: {
        before: row,
        patch,
        after: {
          is_scrap: nextIsScrap,
          location_type: nextLocationType,
          allow_outbound: nextAllowOutbound,
        },
      },
    });

    const out = await client.query<StockEmplacementListItem>(
      `
        SELECT
          e.id::int AS id,
          e.magasin_id::text AS magasin_id,
          COALESCE(m.code, m.code_magasin)::text AS magasin_code,
          COALESCE(m.name, m.libelle)::text AS magasin_name,
          e.code,
          e.name,
          e.is_scrap,
          e.is_active,
          e.location_type,
          e.allow_inbound,
          e.allow_outbound,
          e.restrictions,
          e.updated_at::text AS updated_at,
          e.created_at::text AS created_at
        FROM public.emplacements e
        JOIN public.magasins m ON m.id = e.magasin_id
        WHERE e.id = $1::bigint
      `,
      [id]
    );
    await client.query("COMMIT");
    return out.rows[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Emplacement code already exists in this magasin");
    }
    throw err;
  } finally {
    client.release();
  }
}
