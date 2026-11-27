import type { PoolClient } from "pg";import db from "../../../config/database";import { generateStockLotCode } from "../../../shared/codes/stock-lot-code.service";import { HttpError } from "../../../utils/httpError";import type { Paginated, StockLotDetail, StockLotGenealogy, StockLotGenealogyEdge, StockLotListItem } from "../types/stock.types";import type { CreateLotBodyDTO, CreateLotGenealogyBodyDTO, ListLotsQueryDTO, UpdateLotBodyDTO, UpdateLotQualityBodyDTO } from "../validators/stock.validators";import { normalizeLikeQuery, sortDirection } from "./stock-query.repository";import { beginStockCommand, completeStockCommand, insertAuditLog, isPgUniqueViolation, type AuditContext } from "./stock-movement-core.repository";import { lockStockLaneTopology } from "./stock-lane-routing.repository";import { reconcileReleasedConsolidationLot } from "../../production/repository/production-receipt-lot-reconciliation.repository";import { tableColumnExists } from "./stock-schema.repository";



function lotSortColumn(sortBy: ListLotsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "created_at":
      return "l.created_at";
    case "lot_code":
      return "l.lot_code";
    case "received_at":
      return "l.received_at";
    case "updated_at":
    default:
      return "l.updated_at";
  }
}



export async function repoListLots(filters: ListLotsQueryDTO): Promise<Paginated<StockLotListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.article_id) where.push(`l.article_id = ${push(filters.article_id)}::uuid`);
  if (filters.lot_status) where.push(`l.lot_status = ${push(filters.lot_status)}`);
  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(
      `(
        l.lot_code ILIKE ${p}
        OR COALESCE(l.supplier_lot_code, '') ILIKE ${p}
        OR a.code ILIKE ${p}
        OR a.designation ILIKE ${p}
      )`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = lotSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.lots l JOIN public.articles a ON a.id = l.article_id ${whereSql}`,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      l.id::text AS id,
      l.article_id::text AS article_id,
      a.code AS article_code,
      a.designation AS article_designation,
      l.lot_code,
      l.lot_status,
      l.lot_status_note,
      l.supplier_lot_code,
      l.received_at::text AS received_at,
      l.manufactured_at::text AS manufactured_at,
      l.expiry_at::text AS expiry_at,
      NULLIF(to_jsonb(l) ->> 'quantite_lineaire_totale_mm', '')::float8 AS quantite_lineaire_totale_mm,
      l.updated_at::text AS updated_at,
      l.created_at::text AS created_at
    FROM public.lots l
    JOIN public.articles a ON a.id = l.article_id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockLotListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}



export async function repoGetLot(id: string): Promise<StockLotDetail | null> {
  const res = await db.query<StockLotDetail>(
    `
      SELECT
        l.id::text AS id,
        l.article_id::text AS article_id,
        a.code AS article_code,
        a.designation AS article_designation,
        a.unite AS unit_code,
        l.client_proprietaire_id::text AS client_proprietaire_id,
        c.company_name AS owner_client_name,
        COALESCE(l.material_properties, '{}'::jsonb) AS material_properties,
        (SELECT COALESCE(sum(b.qty_total),0)::float8 FROM public.stock_batches b WHERE b.lot_id=l.id) AS quantity_on_hand,
        (SELECT COALESCE(sum(b.qty_reserved),0)::float8 FROM public.stock_batches b WHERE b.lot_id=l.id) AS quantity_reserved,
        l.lot_code,
        l.lot_status,
        l.lot_status_note,
        l.supplier_lot_code,
        l.received_at::text AS received_at,
        l.manufactured_at::text AS manufactured_at,
        l.expiry_at::text AS expiry_at,
        NULLIF(to_jsonb(l) ->> 'quantite_lineaire_totale_mm', '')::float8 AS quantite_lineaire_totale_mm,
        l.notes,
        to_char(l.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
        l.created_at::text AS created_at
      FROM public.lots l
      JOIN public.articles a ON a.id = l.article_id
      LEFT JOIN public.clients c ON c.client_id = l.client_proprietaire_id
      WHERE l.id = $1::uuid
    `,
    [id]
  );
  return res.rows[0] ?? null;
}



export async function repoCreateLot(body: CreateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (body.lot_code?.trim()) {
      throw new HttpError(400, "LOT_CODE_SERVER_MANAGED", "Le numéro de lot interne est attribué automatiquement.");
    }
    const article = await client.query<{ article_category: string }>(
      "SELECT article_category FROM public.articles WHERE id=$1::uuid FOR KEY SHARE",
      [body.article_id]
    );
    const lotCode = await generateStockLotCode(client, article.rows[0]?.article_category);
    const res = await client.query<{ id: string }>(
      `
        INSERT INTO public.lots (
          article_id, lot_code, supplier_lot_code,
          received_at, manufactured_at, expiry_at,
          notes, created_by, updated_by
        )
        VALUES ($1::uuid,$2,$3,$4::date,$5::date,$6::date,$7,$8,$8)
        RETURNING id::text AS id
      `,
      [
        body.article_id,
        lotCode,
        body.supplier_lot_code ?? null,
        body.received_at ?? null,
        body.manufactured_at ?? null,
        body.expiry_at ?? null,
        body.notes ?? null,
        audit.user_id,
      ]
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("Failed to create lot");
    if (body.quantite_lineaire_totale_mm !== undefined) {
      if (!(await tableColumnExists(client, "lots", "quantite_lineaire_totale_mm"))) {
        throw new HttpError(
          503,
          "STOCK_SCHEMA_UPGRADE_REQUIRED",
          "Le patch additif #164 doit être appliqué avant d'enregistrer une quantité linéaire de lot."
        );
      }
      await client.query(
        `UPDATE public.lots
         SET quantite_lineaire_totale_mm = $2::numeric
         WHERE id = $1::uuid`,
        [id, body.quantite_lineaire_totale_mm ?? null]
      );
    }

    await insertAuditLog(client, audit, {
      action: "stock.lots.create",
      entity_type: "lots",
      entity_id: id,
      details: { article_id: body.article_id, lot_code: lotCode },
    });

    await client.query("COMMIT");

    const out = await repoGetLot(id);
    if (!out) throw new Error("Failed to read created lot");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Lot code already exists for this article");
    }
    throw err;
  } finally {
    client.release();
  }
}



export async function repoUpdateLot(id: string, patch: UpdateLotBodyDTO, audit: AuditContext): Promise<StockLotDetail | null> {
  if (patch.lot_code !== undefined) {
    throw new HttpError(400, "LOT_CODE_IMMUTABLE", "Le numéro de lot interne ne peut pas être modifié.");
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (patch.supplier_lot_code !== undefined) sets.push(`supplier_lot_code = ${push(patch.supplier_lot_code)}`);
  if (patch.received_at !== undefined) sets.push(`received_at = ${push(patch.received_at)}::date`);
  if (patch.manufactured_at !== undefined) sets.push(`manufactured_at = ${push(patch.manufactured_at)}::date`);
  if (patch.expiry_at !== undefined) sets.push(`expiry_at = ${push(patch.expiry_at)}::date`);
  if (patch.quantite_lineaire_totale_mm !== undefined) {
    if (!(await tableColumnExists(db, "lots", "quantite_lineaire_totale_mm"))) {
      throw new HttpError(
        503,
        "STOCK_SCHEMA_UPGRADE_REQUIRED",
        "Le patch additif #164 doit être appliqué avant d'enregistrer une quantité linéaire de lot."
      );
    }
    sets.push(`quantite_lineaire_totale_mm = ${push(patch.quantite_lineaire_totale_mm)}::numeric`);
  }
  if (patch.notes !== undefined) sets.push(`notes = ${push(patch.notes)}`);
  sets.push(`updated_at = now()`);
  sets.push(`updated_by = ${push(audit.user_id)}`);

  try {
    const res = await db.query<{ id: string }>(
      `UPDATE public.lots SET ${sets.join(", ")} WHERE id = ${push(id)}::uuid RETURNING id::text AS id`,
      values
    );
    if (!res.rows[0]?.id) return null;

    await insertAuditLog(db, audit, {
      action: "stock.lots.update",
      entity_type: "lots",
      entity_id: id,
      details: { patch },
    });

    return repoGetLot(id);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new HttpError(409, "DUPLICATE", "Lot code already exists for this article");
    }
    throw err;
  }
}



export async function repoUpdateLotQuality(
  id: string,
  body: UpdateLotQualityBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockLotDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockStockLaneTopology(client);
    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "LOT_QUALITY_CHANGE",
      request_payload: { lot_id: id, ...body },
    });
    if (command.existing) {
      await client.query("COMMIT");
      return repoGetLot(command.existing.resource_id);
    }

    const locked = await client.query<{
      lot_status: StockLotDetail["lot_status"];
      lot_status_note: string | null;
      updated_at: string;
    }>(
      `
        SELECT lot_status, lot_status_note, updated_at::text AS updated_at
        FROM public.lots
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [id]
    );
    const lot = locked.rows[0] ?? null;
    if (!lot) {
      await client.query("ROLLBACK");
      return null;
    }
    if (new Date(lot.updated_at).getTime() !== new Date(body.expected_updated_at).getTime()) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Lot quality status has changed");
    }
    if (lot.lot_status === body.lot_status) {
      throw new HttpError(409, "QUALITY_STATUS_UNCHANGED", "Lot already has this quality status");
    }

    if (body.lot_status === "LIBERE") {
      const openNc = await client.query<{ count: number }>(
        `
          SELECT COUNT(*)::int AS count
          FROM public.non_conformity
          WHERE lot_id = $1::uuid
            AND status::text <> 'CLOSED'
        `,
        [id]
      );
      if ((openNc.rows[0]?.count ?? 0) > 0) {
        throw new HttpError(
          409,
          "LOT_OPEN_NON_CONFORMITY",
          "Lot cannot be released while a non-conformity remains open"
        );
      }
    }

    await client.query(
      `
        UPDATE public.lots
        SET
          lot_status = $2,
          lot_status_note = $3,
          updated_at = now(),
          updated_by = $4
        WHERE id = $1::uuid
      `,
      [id, body.lot_status, body.reason, audit.user_id]
    );
    if(body.lot_status==='LIBERE')await reconcileReleasedConsolidationLot(client,id,audit.user_id);
    await client.query(
      `
        INSERT INTO public.stock_lot_event_log (
          lot_id,
          event_type,
          old_values,
          new_values,
          actor_user_id,
          correlation_id
        )
        VALUES (
          $1::uuid,
          'QUALITY_STATUS_CHANGED',
          $2::jsonb,
          $3::jsonb,
          $4,
          $5::uuid
        )
      `,
      [
        id,
        JSON.stringify({
          lot_status: lot.lot_status,
          lot_status_note: lot.lot_status_note,
          updated_at: lot.updated_at,
        }),
        JSON.stringify({ lot_status: body.lot_status, reason: body.reason }),
        audit.user_id,
        command.correlation_id,
      ]
    );
    await insertAuditLog(client, audit, {
      action: "stock.lots.quality_status.change",
      entity_type: "lots",
      entity_id: id,
      details: {
        before: { lot_status: lot.lot_status, lot_status_note: lot.lot_status_note },
        after: { lot_status: body.lot_status, lot_status_note: body.reason },
        correlation_id: command.correlation_id,
      },
    });
    await completeStockCommand(client, {
      audit,
      command,
      command_type: "LOT_QUALITY_CHANGE",
      resource_type: "stock_lot",
      resource_id: id,
      result_payload: { lot_id: id, lot_status: body.lot_status },
    });
    await client.query("COMMIT");
    return repoGetLot(id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}



const LOT_GENEALOGY_EDGE_SELECT = `
  SELECT
    edge.id::text AS id,
    edge.parent_lot_id::text AS parent_lot_id,
    parent_lot.lot_code AS parent_lot_code,
    parent_lot.article_id::text AS parent_article_id,
    parent_article.code AS parent_article_code,
    edge.child_lot_id::text AS child_lot_id,
    child_lot.lot_code AS child_lot_code,
    child_lot.article_id::text AS child_article_id,
    child_article.code AS child_article_code,
    edge.operation_type,
    edge.qty_contributed::float8 AS qty_contributed,
    edge.unit_code,
    edge.stock_movement_id::text AS stock_movement_id,
    edge.correlation_id::text AS correlation_id,
    edge.created_at::text AS created_at
  FROM genealogy edge
  JOIN public.lots parent_lot ON parent_lot.id = edge.parent_lot_id
  JOIN public.articles parent_article ON parent_article.id = parent_lot.article_id
  JOIN public.lots child_lot ON child_lot.id = edge.child_lot_id
  JOIN public.articles child_article ON child_article.id = child_lot.article_id
`;



export async function repoGetLotGenealogy(id: string): Promise<StockLotGenealogy | null> {
  const lot = await repoGetLot(id);
  if (!lot) return null;

  const ancestors = await db.query<StockLotGenealogyEdge>(
    `
      WITH RECURSIVE genealogy AS (
        SELECT edge.*
        FROM public.stock_lot_genealogy_edges edge
        WHERE edge.child_lot_id = $1::uuid
        UNION
        SELECT parent_edge.*
        FROM public.stock_lot_genealogy_edges parent_edge
        JOIN genealogy current_edge
          ON parent_edge.child_lot_id = current_edge.parent_lot_id
      )
      ${LOT_GENEALOGY_EDGE_SELECT}
      ORDER BY edge.created_at DESC, edge.id
    `,
    [id]
  );
  const descendants = await db.query<StockLotGenealogyEdge>(
    `
      WITH RECURSIVE genealogy AS (
        SELECT edge.*
        FROM public.stock_lot_genealogy_edges edge
        WHERE edge.parent_lot_id = $1::uuid
        UNION
        SELECT child_edge.*
        FROM public.stock_lot_genealogy_edges child_edge
        JOIN genealogy current_edge
          ON child_edge.parent_lot_id = current_edge.child_lot_id
      )
      ${LOT_GENEALOGY_EDGE_SELECT}
      ORDER BY edge.created_at ASC, edge.id
    `,
    [id]
  );
  return { lot, ancestors: ancestors.rows, descendants: descendants.rows };
}



export async function repoCreateLotGenealogy(
  body: CreateLotGenealogyBodyDTO,
  audit: AuditContext,
  idempotencyKey: string,
  transactionClient?: PoolClient
): Promise<{ correlation_id: string; edges: StockLotGenealogyEdge[] }> {
  const client = transactionClient ?? await db.connect();
  const ownsTransaction = !transactionClient;
  try {
    if (ownsTransaction) await client.query("BEGIN");
    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "LOT_GENEALOGY_RECORD",
      request_payload: body,
    });
    if (command.existing) {
      const edges = await client.query<StockLotGenealogyEdge>(
        `
          WITH genealogy AS (
            SELECT *
            FROM public.stock_lot_genealogy_edges
            WHERE correlation_id = $1::uuid
          )
          ${LOT_GENEALOGY_EDGE_SELECT}
          ORDER BY edge.created_at, edge.id
        `,
        [command.existing.correlation_id]
      );
      if (ownsTransaction) await client.query("COMMIT");
      return { correlation_id: command.existing.correlation_id, edges: edges.rows };
    }

    const movement = await client.query<{ id: string }>(
      `
        SELECT id::text AS id
        FROM public.stock_movements
        WHERE id = $1::uuid
          AND status::text = 'POSTED'
        FOR SHARE
      `,
      [body.stock_movement_id]
    );
    if (!movement.rows[0]?.id) {
      throw new HttpError(
        409,
        "POSTED_MOVEMENT_REQUIRED",
        "A posted stock movement is required for lot genealogy"
      );
    }

    const parentQty = body.parents.reduce((sum, item) => sum + item.qty, 0);
    const childQty = body.children.reduce((sum, item) => sum + item.qty, 0);
    if (Math.abs(parentQty - childQty) > 1e-6) {
      throw new HttpError(
        409,
        "GENEALOGY_QTY_MISMATCH",
        "Parent and child genealogy quantities must balance"
      );
    }

    const lotIds = [...body.parents, ...body.children].map((item) => item.lot_id).sort();
    for (const lotId of lotIds) {
      const lot = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM public.lots WHERE id = $1::uuid FOR SHARE`,
        [lotId]
      );
      if (!lot.rows[0]?.id) throw new HttpError(400, "INVALID_LOT", "Unknown genealogy lot");
    }

    const contributions =
      body.operation_type === "SPLIT"
        ? body.children.map((child) => ({
            parent_lot_id: body.parents[0]!.lot_id,
            child_lot_id: child.lot_id,
            qty: child.qty,
          }))
        : body.operation_type === "MERGE"
          ? body.parents.map((parent) => ({
              parent_lot_id: parent.lot_id,
              child_lot_id: body.children[0]!.lot_id,
              qty: parent.qty,
            }))
          : [
              {
                parent_lot_id: body.parents[0]!.lot_id,
                child_lot_id: body.children[0]!.lot_id,
                qty: body.children[0]!.qty,
              },
            ];

    for (const contribution of contributions) {
      await client.query(
        `
          INSERT INTO public.stock_lot_genealogy_edges (
            parent_lot_id,
            child_lot_id,
            operation_type,
            qty_contributed,
            unit_code,
            stock_movement_id,
            correlation_id,
            created_by
          )
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8)
        `,
        [
          contribution.parent_lot_id,
          contribution.child_lot_id,
          body.operation_type,
          contribution.qty,
          body.unit_code,
          body.stock_movement_id,
          command.correlation_id,
          audit.user_id,
        ]
      );
    }

    const touchedLots = [...new Set(lotIds)];
    for (const lotId of touchedLots) {
      await client.query(
        `
          INSERT INTO public.stock_lot_event_log (
            lot_id,
            event_type,
            old_values,
            new_values,
            actor_user_id,
            correlation_id
          )
          VALUES ($1::uuid,'GENEALOGY_RECORDED',NULL,$2::jsonb,$3,$4::uuid)
        `,
        [
          lotId,
          JSON.stringify({
            operation_type: body.operation_type,
            stock_movement_id: body.stock_movement_id,
          }),
          audit.user_id,
          command.correlation_id,
        ]
      );
    }
    await completeStockCommand(client, {
      audit,
      command,
      command_type: "LOT_GENEALOGY_RECORD",
      resource_type: "stock_lot_genealogy",
      resource_id: command.correlation_id,
      result_payload: {
        correlation_id: command.correlation_id,
        edges_count: contributions.length,
      },
    });
    if (ownsTransaction) await client.query("COMMIT");

    const edges = await client.query<StockLotGenealogyEdge>(
      `
        WITH genealogy AS (
          SELECT *
          FROM public.stock_lot_genealogy_edges
          WHERE correlation_id = $1::uuid
        )
        ${LOT_GENEALOGY_EDGE_SELECT}
        ORDER BY edge.created_at, edge.id
      `,
      [command.correlation_id]
    );
    return { correlation_id: command.correlation_id, edges: edges.rows };
  } catch (error) {
    if (ownsTransaction) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}
