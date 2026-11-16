import db from "../../../config/database";
import { stockLotTraceReferenceValuesSql } from "../../../shared/provenance/stock-lot-trace.sql";
import type {
  ConsolidatedInventoryRow,
  Paginated,
  StockAnalytics,
  StockBalanceRow,
  StockMovementListItem,
} from "../types/stock.types";
import type {
  ListAnalyticsQueryDTO,
  ListBalancesQueryDTO,
  ListConsolidatedInventoryQueryDTO,
  ListMovementsQueryDTO,
} from "../validators/stock.validators";
import { readMaterialBarCountRequirementsTx } from "./material-bar-count-read-model.repository";
import {
  oldMaterialDefinitionFromProjection,
  pieceClientCodeSql,
  type OldMaterialDefinitionProjection,
} from "./stock-article-projection";
import { normalizeLikeQuery, sortDirection } from "./stock-query.repository";



function movementSortColumn(sortBy: ListMovementsQueryDTO["sortBy"]): string {
  switch (sortBy) {
    case "id":
      return "m.id";
    case "created_at":
      return "m.created_at";
    case "updated_at":
      return "m.updated_at";
    case "posted_at":
      return "m.posted_at";
    case "movement_no":
      return "m.movement_no";
    case "effective_at":
    default:
      return "m.effective_at";
  }
}


/** Read model used by the singular, consolidated inventory screen. Count sessions
 * remain under /inventory-sessions and are deliberately not folded into it. */
export async function repoListConsolidatedInventory(
  filters: ListConsolidatedInventoryQueryDTO
): Promise<Paginated<ConsolidatedInventoryRow>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 100;
  const offset = (page - 1) * pageSize;
  const values: unknown[] = [];
  const where: string[] = [];
  const push = (value: unknown) => { values.push(value); return `$${values.length}`; };

  const effectiveScopeSql = `CASE
    WHEN l.origin_stock_scope = 'OLD' THEN 'OLD'
    ELSE COALESCE(l.source_scope, l.stock_scope, m.stock_scope, w.stock_scope, 'NEW')
  END`;
  if (filters.scope) where.push(`${effectiveScopeSql} = ${push(filters.scope)}`);
  if (filters.magasin_id) where.push(`e.magasin_id = ${push(filters.magasin_id)}::uuid`);
  if (filters.rayon) where.push(`e.code ILIKE ${push(normalizeLikeQuery(filters.rayon))}`);
  if (filters.lot) where.push(`COALESCE(l.lot_code, '') ILIKE ${push(normalizeLikeQuery(filters.lot))}`);
  if (filters.q) {
    const p = push(normalizeLikeQuery(filters.q));
    where.push(`(a.code ILIKE ${p} OR a.designation ILIKE ${p} OR COALESCE(l.lot_code, '') ILIKE ${p})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sort = {
    article_code: "a.code",
    scope: effectiveScopeSql,
    magasin_code: "COALESCE(m.code, m.code_magasin, w.code)",
    rayon_code: "COALESCE(e.code, loc.code)",
    lot_code: "l.lot_code",
    qty_available: "b.qty_available",
  }[filters.sortBy ?? "article_code"];
  const direction = sortDirection(filters.sortDir);
  const fromSql = `
    FROM public.v_stock_availability_225 b
    JOIN public.articles a ON a.id = b.article_id
    LEFT JOIN public.pieces_techniques piece ON piece.id = a.piece_technique_id
    LEFT JOIN public.clients piece_client ON piece_client.client_id = piece.client_id
    LEFT JOIN LATERAL (
      SELECT version.plan_reference, version.indice
      FROM public.piece_technique_versions version
      WHERE version.piece_technique_id = piece.id
      ORDER BY (version.statut = 'APPLICABLE') DESC, version.is_current DESC,
               version.version_interne DESC, version.created_at DESC
      LIMIT 1
    ) article_version ON true
    JOIN public.warehouses w ON w.id = b.warehouse_id
    JOIN public.locations loc ON loc.id = b.location_id
    LEFT JOIN public.emplacements e ON e.location_id = b.location_id
    LEFT JOIN public.magasins m ON m.id = e.magasin_id
    LEFT JOIN public.lots l ON l.id = b.lot_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(movement_line.qty), 0)::float8 AS qty_initial
      FROM public.stock_movement_lines movement_line
      JOIN public.stock_movements movement ON movement.id = movement_line.movement_id
      WHERE movement_line.lot_id = b.lot_id
        AND movement.status = 'POSTED'
        AND movement.source_document_type = 'CERP_HISTORICAL_OPENING'
    ) opening ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        ARRAY(
          SELECT DISTINCT reference_value
          FROM (
            SELECT reference.reference_value
            FROM public.stock_lot_trace_references reference
            WHERE reference.lot_id = b.lot_id AND reference.reference_type = 'OF'
            UNION ALL
            SELECT fabrication.numero
            FROM public.of_output_lots output
            JOIN public.ordres_fabrication fabrication ON fabrication.id = output.of_id
            WHERE output.lot_id = b.lot_id
          ) values_of(reference_value)
          WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
          ORDER BY reference_value
        ) AS of_references,
        ARRAY(
          SELECT DISTINCT reference_value
          FROM (${stockLotTraceReferenceValuesSql("b.lot_id", "MP_LOT")}) recorded_origins
          WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
          ORDER BY reference_value
        ) AS mp_references,
        ARRAY(
          SELECT DISTINCT reference_value
          FROM (${stockLotTraceReferenceValuesSql("b.lot_id", "TRAITEMENT_LOT")}) recorded_origins
          WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
          ORDER BY reference_value
        ) AS tr_references
    ) traceability ON b.lot_id IS NOT NULL
    LEFT JOIN public.articles_matiere article_material ON article_material.article_id = a.id
    LEFT JOIN public.stock_nuances material_nuance ON material_nuance.id = article_material.nuance_id
    LEFT JOIN public.stock_etats material_etat ON material_etat.id = article_material.etat_id
    LEFT JOIN public.stock_sous_etats material_sous_etat ON material_sous_etat.id = article_material.sous_etat_id
  `;
  const count = await db.query<{ total: number }>(`SELECT COUNT(*)::int AS total ${fromSql} ${whereSql}`, values);
  type InventoryRow = Omit<ConsolidatedInventoryRow, "old_material_definition"> & OldMaterialDefinitionProjection;
  const rows = await db.query<InventoryRow>(
    `SELECT
       b.article_id::text AS article_id, a.code AS article_code, a.designation AS article_designation,
       article_version.plan_reference AS article_reference,
       article_version.indice AS piece_indice,
       ${pieceClientCodeSql("piece")} AS client_code,
       a.article_category::text AS material_article_category,
       a.designation AS material_designation,
       COALESCE(article_material.family_code, a.family_code)::text AS material_profile_code,
       material_nuance.code::text AS material_nuance_code,
       material_etat.code::text AS material_etat_code,
       material_sous_etat.code::text AS material_sous_etat_code,
       COALESCE(
         article_material.longueur_brut_mm,
         article_material.longueur_coupe_mm,
         article_material.longueur_mm,
         article_material.longueur_unitaire_mm
       )::float8 AS material_longueur_mm,
       article_material.largeur_mm::float8 AS material_largeur_mm,
       article_material.hauteur_mm::float8 AS material_hauteur_mm,
       article_material.epaisseur_mm::float8 AS material_epaisseur_mm,
       article_material.diametre_mm::float8 AS material_diametre_mm,
       ${effectiveScopeSql}::text AS scope,
       COALESCE(m.id, '00000000-0000-0000-0000-000000000000')::text AS magasin_id,
       COALESCE(m.code, m.code_magasin, w.code)::text AS magasin_code,
       COALESCE(e.code, loc.code)::text AS rayon_code,
       b.lot_id::text AS lot_id, l.lot_code,
       COALESCE(traceability.of_references, ARRAY[]::text[]) AS of_references,
       COALESCE(traceability.mp_references, ARRAY[]::text[]) AS mp_references,
       COALESCE(traceability.tr_references, ARRAY[]::text[]) AS tr_references,
       l.stock_trace_code::text AS stock_trace_code, l.qr_payload,
       CASE WHEN ${effectiveScopeSql} = 'OLD' THEN opening.qty_initial ELSE NULL END::float8 AS qty_initial,
       b.qty_total::float8 AS qty_total, b.qty_reserved::float8 AS qty_reserved,
       b.qty_available::float8 AS qty_available, b.updated_at::text AS updated_at
     ${fromSql} ${whereSql}
     ORDER BY ${sort} ${direction}, a.code ASC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, offset]
  );
  const items = rows.rows.map((row): ConsolidatedInventoryRow => {
    const {
      material_article_category,
      material_designation,
      material_profile_code,
      material_nuance_code,
      material_etat_code,
      material_sous_etat_code,
      material_longueur_mm,
      material_largeur_mm,
      material_hauteur_mm,
      material_epaisseur_mm,
      material_diametre_mm,
      ...inventoryRow
    } = row;
    const projection: OldMaterialDefinitionProjection = {
      material_article_category,
      material_designation,
      material_profile_code,
      material_nuance_code,
      material_etat_code,
      material_sous_etat_code,
      material_longueur_mm,
      material_largeur_mm,
      material_hauteur_mm,
      material_epaisseur_mm,
      material_diametre_mm,
    };
    return {
      ...inventoryRow,
      old_material_definition:
        inventoryRow.scope === "OLD" ? oldMaterialDefinitionFromProjection(projection) : null,
    };
  });
  return { items, total: count.rows[0]?.total ?? 0 };
}


export async function repoListBalances(filters: ListBalancesQueryDTO): Promise<Paginated<StockBalanceRow>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 100;
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.article_id) where.push(`b.article_id = ${push(filters.article_id)}::uuid`);
  if (filters.magasin_id) where.push(`e.magasin_id = ${push(filters.magasin_id)}::uuid`);
  if (filters.emplacement_id) where.push(`e.id = ${push(filters.emplacement_id)}::bigint`);
  if (filters.lot_id) where.push(`b.lot_id = ${push(filters.lot_id)}::uuid`);
  if (filters.lot_status) where.push(`b.lot_status = ${push(filters.lot_status)}`);
  if (filters.only_available === true) where.push(`b.qty_available > 0`);
  if (filters.physical_state === "present") where.push(`b.qty_total > 0`);
  if (filters.physical_state === "archived") where.push(`b.lot_id IS NOT NULL AND b.qty_total <= 0`);
  if (filters.piece_technique_version_id) {
    where.push(`lot.piece_technique_version_id = ${push(filters.piece_technique_version_id)}::uuid`);
  }
  if (filters.warehouse_id) where.push(`b.warehouse_id = ${push(filters.warehouse_id)}::uuid`);
  if (filters.location_id) where.push(`b.location_id = ${push(filters.location_id)}::uuid`);
  if (filters.q && filters.q.trim().length > 0) {
    const p = push(normalizeLikeQuery(filters.q));
    where.push(
      `(
        a.code ILIKE ${p}
        OR a.designation ILIKE ${p}
        OR COALESCE(b.lot_code, '') ILIKE ${p}
      )`
    );
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRes = await db.query<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM public.v_stock_availability_225 b
      JOIN public.articles a ON a.id = b.article_id
      LEFT JOIN public.emplacements e ON e.location_id = b.location_id
      LEFT JOIN public.lots lot ON lot.id = b.lot_id
      ${whereSql}
    `,
    values
  );
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      b.id::text AS id,
      b.stock_batch_id::text AS stock_batch_id,
      b.article_id::text AS article_id,
      a.code AS article_code,
      a.designation AS article_designation,
      e.magasin_id::text AS magasin_id,
      COALESCE(m.code, m.code_magasin)::text AS magasin_code,
      COALESCE(m.name, m.libelle)::text AS magasin_name,
      e.id::int AS emplacement_id,
      e.code AS emplacement_code,
      e.name AS emplacement_name,
      b.lot_id::text AS lot_id,
      b.lot_code,
      lot.piece_technique_version_id::text AS piece_technique_version_id,
      technical_version.indice AS piece_technique_indice,
      technical_version.plan_reference AS piece_plan_reference,
      COALESCE(traceability.of_references, ARRAY[]::text[]) AS of_references,
      COALESCE(traceability.mp_references, ARRAY[]::text[]) AS mp_references,
      COALESCE(traceability.tr_references, ARRAY[]::text[]) AS tr_references,
      b.lot_status,
      b.warehouse_id::text AS warehouse_id,
      w.code::text AS warehouse_code,
      w.name AS warehouse_name,
      b.location_id::text AS location_id,
      l.code::text AS location_code,
      l.description AS location_description,
      b.unit_id::text AS unit_id,
      u.code::text AS unit_code,
      b.managed_in_stock,
      b.qty_total::float8 AS qty_on_hand,
      b.qty_reserved::float8 AS qty_reserved,
      b.qty_depreciated::float8 AS qty_depreciated,
      b.qty_quarantine::float8 AS qty_quarantine,
      b.qty_blocked::float8 AS qty_blocked,
      b.qty_available::float8 AS qty_available,
      b.qty_scrap_recorded::float8 AS qty_scrap_recorded,
      b.updated_at::text AS updated_at
    FROM public.v_stock_availability_225 b
    JOIN public.articles a ON a.id = b.article_id
    JOIN public.warehouses w ON w.id = b.warehouse_id
    JOIN public.locations l ON l.id = b.location_id
    JOIN public.units u ON u.id = b.unit_id
    LEFT JOIN public.emplacements e ON e.location_id = b.location_id
    LEFT JOIN public.magasins m ON m.id = e.magasin_id
    LEFT JOIN public.lots lot ON lot.id = b.lot_id
    LEFT JOIN public.piece_technique_versions technical_version
      ON technical_version.id = lot.piece_technique_version_id
    LEFT JOIN LATERAL (
      SELECT
        ARRAY(
          SELECT DISTINCT reference_value
          FROM (
            SELECT reference.reference_value
            FROM public.stock_lot_trace_references reference
            WHERE reference.lot_id = b.lot_id AND reference.reference_type = 'OF'
            UNION ALL
            SELECT fabrication.numero
            FROM public.of_output_lots output
            JOIN public.ordres_fabrication fabrication ON fabrication.id = output.of_id
            WHERE output.lot_id = b.lot_id
          ) values_of(reference_value)
          WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
          ORDER BY reference_value
        ) AS of_references,
        ARRAY(
          SELECT DISTINCT reference_value
          FROM (
            SELECT reference.reference_value
            FROM public.stock_lot_trace_references reference
            WHERE reference.lot_id = b.lot_id AND reference.reference_type = 'MP_LOT'
            UNION ALL
            SELECT lot.mp_reference
          ) values_mp(reference_value)
          WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
          ORDER BY reference_value
        ) AS mp_references,
        ARRAY(
          SELECT DISTINCT reference_value
          FROM (
            SELECT reference.reference_value
            FROM public.stock_lot_trace_references reference
            WHERE reference.lot_id = b.lot_id AND reference.reference_type = 'TRAITEMENT_LOT'
            UNION ALL
            SELECT lot.tr_reference
          ) values_tr(reference_value)
          WHERE reference_value IS NOT NULL AND btrim(reference_value) <> ''
          ORDER BY reference_value
        ) AS tr_references
    ) traceability ON b.lot_id IS NOT NULL
    ${whereSql}
    ORDER BY a.code ASC, COALESCE(m.code, m.code_magasin, w.code) ASC, COALESCE(e.code, l.code) ASC
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockBalanceRow>(dataSql, [...values, pageSize, offset]);
  const materialRequirements = await readMaterialBarCountRequirementsTx(db, rows.rows);
  return { items: rows.rows.map(row => ({...row, material_bars_required:
    materialRequirements.get(`${row.article_id}:${row.stock_batch_id ?? ''}`)?.material_bar_count_required ?? false})), total };
}


export async function repoGetStockAnalytics(filters: ListAnalyticsQueryDTO): Promise<StockAnalytics> {
  const movementValues: unknown[] = [];
  const currentValues: unknown[] = [];
  const pushMovement = (v: unknown) => {
    movementValues.push(v);
    return `$${movementValues.length}`;
  };
  const pushCurrent = (v: unknown) => {
    currentValues.push(v);
    return `$${currentValues.length}`;
  };

  const movementWhere: string[] = [
    `m.status = 'POSTED'`,
    `(m.doc_type IS DISTINCT FROM 'STOCK_TRANSFER_INTERNAL')`,
    `(m.movement_type IN ('IN','OUT','SCRAP','ADJUSTMENT','ADJUST'))`,
  ];

  const currentWhere: string[] = [];

  if (filters.from) movementWhere.push(`m.effective_at >= ${pushMovement(filters.from)}::timestamptz`);
  if (filters.to) movementWhere.push(`m.effective_at <= ${pushMovement(filters.to)}::timestamptz`);
  if (filters.magasin_id) {
    movementWhere.push(`e.magasin_id = ${pushMovement(filters.magasin_id)}::uuid`);
    currentWhere.push(`e.magasin_id = ${pushCurrent(filters.magasin_id)}::uuid`);
  }

  const movementWhereSql = movementWhere.length ? `WHERE ${movementWhere.join(" AND ")}` : "";
  const currentWhereSql = currentWhere.length ? `WHERE ${currentWhere.join(" AND ")}` : "";
  const currentWhereSqlCombined = currentWhereSql.replace(/\$(\d+)/g, (_match, n: string) => `$${Number(n) + movementValues.length}`);

  const [kpisRes, cockpitRes, magasinsRes, categoriesRes, seriesRes, topArticlesRes] = await Promise.all([
    db.query<StockAnalytics["kpis"]>(
      `
        SELECT
          COUNT(*)::int AS articles_count,
          COUNT(*) FILTER (WHERE a.stock_managed)::int AS stock_managed_articles,
          COALESCE(SUM(cur.qty_total), 0)::float8 AS qty_on_hand,
          COALESCE(SUM(cur.qty_available), 0)::float8 AS qty_available,
          COALESCE(SUM(cur.qty_reserved), 0)::float8 AS qty_reserved
        FROM public.articles a
        LEFT JOIN (
          SELECT
            b.article_id,
            SUM(b.qty_total)::float8 AS qty_total,
            SUM(b.qty_available)::float8 AS qty_available,
            SUM(b.qty_reserved)::float8 AS qty_reserved
          FROM public.v_stock_availability_225 b
          LEFT JOIN public.emplacements e ON e.location_id = b.location_id
          ${currentWhereSql}
          GROUP BY b.article_id
        ) cur ON cur.article_id = a.id
      `,
      currentValues
    ),
    db.query<{
      ruptures_count: number;
      below_minimum_count: number;
      at_risk_reservations_count: number;
      quarantine_lots_count: number;
      active_inventory_count: number;
      discrepancies_to_review_count: number;
    }>(
      `
        WITH scoped_availability AS (
          SELECT
            availability.*,
            level.min_qty::float8 AS min_qty
          FROM public.v_stock_availability_225 availability
          JOIN public.stock_levels level ON level.id = availability.stock_level_id
          LEFT JOIN public.emplacements e ON e.location_id = availability.location_id
          ${currentWhereSql}
        ),
        stock_alerts AS (
          SELECT
            COUNT(*) FILTER (
              WHERE managed_in_stock = true
                AND COALESCE(min_qty, 0) > 0
                AND qty_available <= 0
            )::int AS ruptures_count,
            COUNT(*) FILTER (
              WHERE managed_in_stock = true
                AND COALESCE(min_qty, 0) > 0
                AND qty_available > 0
                AND qty_available < min_qty
            )::int AS below_minimum_count,
            COUNT(DISTINCT lot_id) FILTER (
              WHERE lot_id IS NOT NULL
                AND lot_status IN ('EN_ATTENTE', 'QUARANTAINE', 'BLOQUE')
                AND qty_on_hand > 0
            )::int AS quarantine_lots_count
          FROM scoped_availability
        ),
        reservation_alerts AS (
          SELECT COUNT(*)::int AS at_risk_reservations_count
          FROM public.stock_reservations reservation
          LEFT JOIN scoped_availability availability
            ON availability.article_id = reservation.article_id
           AND availability.location_id = reservation.location_id
           AND availability.lot_id IS NOT DISTINCT FROM reservation.lot_id
          WHERE reservation.status = 'ACTIVE'
            AND (
              (reservation.expires_at IS NOT NULL AND reservation.expires_at <= now() + interval '7 days')
              OR COALESCE(
                availability.qty_on_hand - availability.qty_depreciated,
                0
              ) < reservation.qty_reserved
            )
        ),
        scoped_inventory AS (
          SELECT DISTINCT session.id, session.status
          FROM public.stock_inventory_sessions session
          LEFT JOIN public.stock_inventory_snapshot_lines snapshot
            ON snapshot.session_id = session.id
          WHERE (
            $${currentValues.length + 1}::uuid IS NULL
            OR session.scope_magasin_id = $${currentValues.length + 1}::uuid
            OR snapshot.magasin_id = $${currentValues.length + 1}::uuid
          )
        ),
        inventory_alerts AS (
          SELECT
            COUNT(*) FILTER (WHERE status IN ('DRAFT', 'OPEN', 'APPROVED'))::int
              AS active_inventory_count
          FROM scoped_inventory
        ),
        discrepancy_alerts AS (
          SELECT COUNT(*)::int AS discrepancies_to_review_count
          FROM public.stock_inventory_snapshot_lines snapshot
          JOIN public.stock_inventory_sessions session ON session.id = snapshot.session_id
          LEFT JOIN LATERAL (
            SELECT event.counted_qty
            FROM public.stock_inventory_count_events event
            WHERE event.snapshot_line_id = snapshot.id
            ORDER BY event.count_round DESC, event.created_at DESC, event.id DESC
            LIMIT 1
          ) latest_count ON true
          WHERE session.status IN ('OPEN', 'APPROVED')
            AND latest_count.counted_qty IS NOT NULL
            AND ABS(latest_count.counted_qty - snapshot.theoretical_qty) > 1e-9
            AND (
              $${currentValues.length + 1}::uuid IS NULL
              OR snapshot.magasin_id = $${currentValues.length + 1}::uuid
            )
        )
        SELECT
          stock_alerts.ruptures_count,
          stock_alerts.below_minimum_count,
          reservation_alerts.at_risk_reservations_count,
          stock_alerts.quarantine_lots_count,
          inventory_alerts.active_inventory_count,
          discrepancy_alerts.discrepancies_to_review_count
        FROM stock_alerts
        CROSS JOIN reservation_alerts
        CROSS JOIN inventory_alerts
        CROSS JOIN discrepancy_alerts
      `,
      [...currentValues, filters.magasin_id ?? null]
    ),
    db.query<{ id: string; code: string; name: string }>(
      `
        SELECT id::text AS id, COALESCE(code, code_magasin)::text AS code, COALESCE(name, libelle)::text AS name
        FROM public.magasins
        WHERE is_active = true
        ORDER BY COALESCE(code, code_magasin) ASC
      `
    ),
    db.query<StockAnalytics["category_counts"][number]>(
      `
        SELECT
          a.article_category::text AS article_category,
          COUNT(*)::int AS articles_count,
          COUNT(*) FILTER (WHERE a.stock_managed)::int AS stock_managed_count
        FROM public.articles a
        GROUP BY a.article_category
        ORDER BY a.article_category ASC
      `
    ),
    db.query<StockAnalytics["series"]["net_by_date"][number]>(
      `
        SELECT
          to_char(date_trunc('day', m.effective_at), 'YYYY-MM-DD') AS date,
          COALESCE(SUM(
            CASE
              WHEN m.movement_type = 'IN'::public.movement_type THEN ABS(m.qty)
              WHEN m.movement_type IN ('ADJUST'::public.movement_type,'ADJUSTMENT'::public.movement_type) AND m.qty > 0 THEN ABS(m.qty)
              ELSE 0
            END
          ), 0)::float8 AS qty_in,
          COALESCE(SUM(
            CASE
              WHEN m.movement_type IN ('OUT'::public.movement_type,'SCRAP'::public.movement_type) THEN ABS(m.qty)
              WHEN m.movement_type IN ('ADJUST'::public.movement_type,'ADJUSTMENT'::public.movement_type) AND m.qty < 0 THEN ABS(m.qty)
              ELSE 0
            END
          ), 0)::float8 AS qty_out,
          COALESCE(SUM(
            CASE
              WHEN m.movement_type = 'IN'::public.movement_type THEN ABS(m.qty)
              WHEN m.movement_type IN ('ADJUST'::public.movement_type,'ADJUSTMENT'::public.movement_type) AND m.qty > 0 THEN ABS(m.qty)
              WHEN m.movement_type IN ('OUT'::public.movement_type,'SCRAP'::public.movement_type) THEN -ABS(m.qty)
              WHEN m.movement_type IN ('ADJUST'::public.movement_type,'ADJUSTMENT'::public.movement_type) AND m.qty < 0 THEN -ABS(m.qty)
              ELSE 0
            END
          ), 0)::float8 AS net_qty
        FROM public.stock_movements m
        LEFT JOIN public.stock_levels sl ON sl.id = m.stock_level_id
        LEFT JOIN public.emplacements e ON e.location_id = sl.location_id
        ${movementWhereSql}
        GROUP BY date_trunc('day', m.effective_at)
        ORDER BY date ASC
      `,
      movementValues
    ),
    db.query<StockAnalytics["series"]["top_articles"][number]>(
      `
        WITH moved AS (
          SELECT
            m.article_id,
            SUM(ABS(m.qty))::float8 AS qty_moved
          FROM public.stock_movements m
          LEFT JOIN public.stock_levels sl ON sl.id = m.stock_level_id
          LEFT JOIN public.emplacements e ON e.location_id = sl.location_id
          ${movementWhereSql}
          GROUP BY m.article_id
        ), current_stock AS (
          SELECT
            b.article_id,
            SUM(b.qty_total)::float8 AS qty_on_hand,
            SUM(b.qty_available)::float8 AS qty_available
            FROM public.v_stock_availability_225 b
          LEFT JOIN public.emplacements e ON e.location_id = b.location_id
          ${currentWhereSqlCombined}
          GROUP BY b.article_id
        )
        SELECT
          a.id::text AS article_id,
          a.code,
          a.designation,
          COALESCE(moved.qty_moved, 0)::float8 AS qty_moved,
          COALESCE(current_stock.qty_on_hand, 0)::float8 AS qty_on_hand,
          COALESCE(current_stock.qty_available, 0)::float8 AS qty_available
        FROM public.articles a
        LEFT JOIN moved ON moved.article_id = a.id
        LEFT JOIN current_stock ON current_stock.article_id = a.id
        WHERE COALESCE(moved.qty_moved, 0) > 0 OR COALESCE(current_stock.qty_on_hand, 0) > 0
        ORDER BY COALESCE(moved.qty_moved, 0) DESC, a.code ASC
        LIMIT 8
      `,
      [...movementValues, ...currentValues]
    ),
  ]);

  return {
    authoritative: true,
    as_of: new Date().toISOString(),
    scope: {
      magasin_id: filters.magasin_id ?? null,
      from: filters.from ?? null,
      to: filters.to ?? null,
    },
    kpis: {
      ...(kpisRes.rows[0] ?? {
        articles_count: 0,
        stock_managed_articles: 0,
        qty_on_hand: 0,
        qty_available: 0,
        qty_reserved: 0,
      }),
      ...(cockpitRes.rows[0] ?? {
        ruptures_count: 0,
        below_minimum_count: 0,
        at_risk_reservations_count: 0,
        quarantine_lots_count: 0,
        active_inventory_count: 0,
        discrepancies_to_review_count: 0,
      }),
    },
    magasins: magasinsRes.rows,
    category_counts: categoriesRes.rows,
    series: {
      net_by_date: seriesRes.rows,
      top_articles: topArticlesRes.rows,
    },
  };
}


export async function repoListMovements(filters: ListMovementsQueryDTO): Promise<Paginated<StockMovementListItem>> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const where: string[] = [`(m.doc_type IS DISTINCT FROM 'STOCK_TRANSFER_INTERNAL')`];
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  if (filters.q && filters.q.trim().length > 0) {
    const q = normalizeLikeQuery(filters.q);
    const p = push(q);
    where.push(`(m.movement_no ILIKE ${p} OR COALESCE(m.source_document_id, '') ILIKE ${p})`);
  }
  if (filters.movement_type) where.push(`m.movement_type = ${push(filters.movement_type)}::public.movement_type`);
  if (filters.status) where.push(`m.status = ${push(filters.status)}`);
  if (filters.article_id) where.push(`m.article_id = ${push(filters.article_id)}::uuid`);
  if (filters.piece_technique_version_id) {
    const versionParam = push(filters.piece_technique_version_id);
    where.push(`EXISTS (
      SELECT 1
      FROM public.stock_movement_lines version_line
      JOIN public.lots version_lot ON version_lot.id = version_line.lot_id
      WHERE version_line.movement_id = m.id
        AND version_lot.piece_technique_version_id = ${versionParam}::uuid
    )`);
  }
  if (filters.from) where.push(`m.effective_at >= ${push(filters.from)}::timestamptz`);
  if (filters.to) where.push(`m.effective_at <= ${push(filters.to)}::timestamptz`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = movementSortColumn(filters.sortBy);
  const orderDir = sortDirection(filters.sortDir);

  const countRes = await db.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM public.stock_movements m ${whereSql}`, values);
  const total = countRes.rows[0]?.total ?? 0;

  const dataSql = `
    SELECT
      m.id::text AS id,
      m.movement_no,
      m.movement_type::text AS movement_type,
      m.status,
      m.article_id::text AS article_id,
      a.code AS article_code,
      a.designation AS article_designation,
      COALESCE(technical_version.plan_reference, latest_version.plan_reference) AS article_reference,
      COALESCE(technical_version.id, latest_version.id)::text AS piece_technique_version_id,
      COALESCE(technical_version.indice, latest_version.indice) AS piece_technique_indice,
      COALESCE(technical_version.version_interne, latest_version.version_interne)::int AS piece_technique_version,
      CASE
        WHEN m.movement_type::text = 'IN' THEN 'IN'
        WHEN m.movement_type::text IN ('OUT','SCRAP','DEPRECIATE') THEN 'OUT'
        WHEN m.movement_type::text = 'TRANSFER' THEN 'TRANSFER'
        WHEN m.movement_type::text IN ('ADJUST','ADJUSTMENT') AND m.qty < 0 THEN 'OUT'
        WHEN m.movement_type::text IN ('ADJUST','ADJUSTMENT') AND m.qty >= 0 THEN 'IN'
        ELSE NULL
      END::text AS direction,
      ABS(m.qty)::float8 AS qty_total,
      m.effective_at::text AS effective_at,
      m.posted_at::text AS posted_at,
      m.source_document_type,
      m.source_document_id,
      COALESCE(inventory_session.session_no, delivery.numero, fabrication.numero, m.source_document_id) AS source_document_no,
      m.reason_code,
      m.correlation_id::text AS correlation_id,
      m.reversal_of_id::text AS reversal_of_id,
      m.updated_at::text AS updated_at,
      m.created_at::text AS created_at,
      COALESCE(ml.lines_count, 0)::int AS lines_count
    FROM public.stock_movements m
    JOIN public.articles a ON a.id = m.article_id
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN COUNT(DISTINCT resolved.version_id) = 1
          THEN (array_agg(DISTINCT resolved.version_id))[1]
        ELSE NULL
      END AS version_id
      FROM (
        SELECT lot.piece_technique_version_id AS version_id
        FROM public.stock_movement_lines line
        JOIN public.lots lot ON lot.id = line.lot_id
        WHERE line.movement_id = m.id
          AND lot.piece_technique_version_id IS NOT NULL
      ) resolved
    ) movement_version ON true
    LEFT JOIN public.piece_technique_versions technical_version
      ON technical_version.id = movement_version.version_id
    LEFT JOIN LATERAL (
      SELECT version.id, version.plan_reference, version.indice, version.version_interne
      FROM public.piece_technique_versions version
      WHERE version.piece_technique_id = a.piece_technique_id
      ORDER BY (version.statut = 'APPLICABLE') DESC, version.is_current DESC,
               version.version_interne DESC, version.created_at DESC
      LIMIT 1
    ) latest_version ON true
    LEFT JOIN public.stock_inventory_sessions inventory_session
      ON m.source_document_type = 'stock_inventory_session'
     AND inventory_session.id::text = m.source_document_id
    LEFT JOIN public.bon_livraison delivery
      ON m.source_document_type = 'BON_LIVRAISON'
     AND delivery.id::text = m.source_document_id
    LEFT JOIN public.ordres_fabrication fabrication
      ON m.source_document_type = 'OF'
     AND fabrication.id::text = m.source_document_id
    LEFT JOIN (
      SELECT movement_id, COUNT(*)::int AS lines_count
      FROM public.stock_movement_lines
      GROUP BY movement_id
    ) ml ON ml.movement_id = m.id
    ${whereSql}
    ORDER BY ${orderBy} ${orderDir}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const rows = await db.query<StockMovementListItem>(dataSql, [...values, pageSize, offset]);
  return { items: rows.rows, total };
}
