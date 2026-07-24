import type { PoolClient } from "pg";
import { createHash, randomUUID } from "crypto";

import pool from "../../../config/database";
import { generateTransactionalBusinessCode } from "../../../shared/codes/code-generator.service";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type { AuditContext } from "./production.repository";
import type { OfReceiptBodyDTO } from "../validators/production.validators";
import { ofStatutAllowsReceipt, type OfStatut } from "../domain/of-status";

export type OfReceiptContext = {
  of: {
    id: number;
    numero: string;
    piece_technique_id: string;
    piece_code: string;
    piece_designation: string;
    quantite_lancee: number;
    quantite_bonne: number;
    statut: string;
    updated_at: string;
    affaire_id: number | null;
    commande_id: number | null;
    commande_ligne_id: number | null;
  };
  article_id: string;
  unite: string | null;
  received_qty_ok: number;
  qty_ok_receivable: number;
  default_location_id: string | null;
  output_lots: Array<{
    lot_id: string;
    lot_code: string;
    lot_status: string;
    qty_ok: number;
    qty_scrap: number;
    qty_rework: number;
    updated_at: string;
  }>;
  existing_lots: Array<{
    lot_id: string;
    lot_code: string;
    lot_status: string;
    qty_on_hand: number;
    updated_at: string;
  }>;
  locations: {
    magasins: Array<{ id: string; code: string; name: string; is_active: boolean }>;
    emplacements: Array<{ id: number; magasin_id: string; code: string; name: string | null; location_id: string }>;
  };
};

export type OfReceiptResult = {
  receipt_id: string;
  lot_id: string;
  lot_code: string;
  stock_movement_id: string;
  movement_no: string;
  qty_ok: number;
  qty_scrap: number;
  qty_rework: number;
  quality_status: string;
  reservation_id: string | null;
  reserved_qty: number;
  non_conformity_id: string | null;
  idempotent_replay: boolean;
};

export type OfTraceability = {
  output_lots: OfReceiptContext["output_lots"];
  receipts: Array<{
    receipt_id: string | null;
    stock_movement_id: string;
    movement_no: string | null;
    status: string;
    posted_at: string | null;
    qty: number;
    qty_scrap: number;
    qty_rework: number;
    quality_status: string | null;
    reservation_id: string | null;
    non_conformity_id: string | null;
    lot_id: string | null;
    lot_code: string | null;
    magasin_id: string | null;
    magasin_code: string | null;
    magasin_name: string | null;
    emplacement_id: number | null;
    emplacement_code: string | null;
    location_id: string | null;
  }>;
};

function movementNoFromSeq(n: number): string {
  const padded = String(n).padStart(8, "0");
  return `SM-${padded}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function receiptRequestHash(ofId: number, body: OfReceiptBodyDTO): string {
  return createHash("sha256").update(canonicalJson({ of_id: ofId, ...body })).digest("hex");
}

async function reserveMovementNo(client: Pick<PoolClient, "query">): Promise<string> {
  const res = await client.query<{ n: string }>("SELECT nextval('public.stock_movement_no_seq')::text AS n");
  const raw = res.rows[0]?.n;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error("Failed to reserve stock movement number");
  return movementNoFromSeq(n);
}

async function insertAuditLog(tx: Pick<PoolClient, "query">, audit: AuditContext, entry: {
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details?: Record<string, unknown> | null;
}) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };

  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

async function resolveArticleForPieceTechnique(client: Pick<PoolClient, "query">, pieceTechniqueId: string): Promise<{ id: string; unite: string | null }> {
  const res = await client.query<{ id: string; unite: string | null }>(
    `
      SELECT id::text AS id, unite
      FROM public.articles
      WHERE piece_technique_id = $1::uuid
        AND article_type = 'PIECE_TECHNIQUE'
        AND is_active = true
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
    [pieceTechniqueId]
  );
  const row = res.rows[0] ?? null;
  if (!row) {
    throw new HttpError(409, "STOCK_ARTICLE_NOT_FOUND", "Aucun article de stock n'est configure pour cette piece technique");
  }
  return row;
}

async function reserveProducedQtyForCommandeLine(
  client: Pick<PoolClient, "query">,
  args: {
    commande_ligne_id: number;
    article_id: string;
    location_id: string;
    stock_level_id: string;
    stock_batch_id: string;
    lot_id: string;
    qty_ok: number;
    actor_user_id: number;
  }
): Promise<{ reservation_id: string; qty_reserved: number } | null> {
  if (!Number.isFinite(args.qty_ok) || args.qty_ok <= 0) return null;

  const lineRes = await client.query<{ quantite: number; article_id: string | null }>(
    `
      SELECT
        quantite::float8 AS quantite,
        article_id::text AS article_id
      FROM public.commande_ligne
      WHERE id = $1::bigint
      FOR UPDATE
    `,
    [args.commande_ligne_id]
  );
  const line = lineRes.rows[0] ?? null;
  if (!line) return null;
  if (line.article_id && line.article_id !== args.article_id) {
    throw new HttpError(409, "ARTICLE_MISMATCH", "La ligne de commande n'est pas liee a l'article recu en stock");
  }

  const currentReservedRes = await client.query<{ qty_reserved: number }>(
    `
      SELECT COALESCE(SUM(qty_reserved), 0)::float8 AS qty_reserved
      FROM public.stock_reservations
      WHERE source_type = 'COMMANDE_LIGNE'
        AND source_id = $1
        AND status = 'ACTIVE'
    `,
    [String(args.commande_ligne_id)]
  );

  const orderedQty = Number(line.quantite);
  const alreadyReserved = Number(currentReservedRes.rows[0]?.qty_reserved ?? 0);
  const remainingToReserve = Math.max(0, orderedQty - alreadyReserved);
  const qtyToReserve = Math.min(args.qty_ok, remainingToReserve);
  if (qtyToReserve <= 0) return null;

  const stockLevelRes = await client.query<{ qty_total: number; qty_reserved: number }>(
    `
      SELECT qty_total::float8 AS qty_total, qty_reserved::float8 AS qty_reserved
      FROM public.stock_levels
      WHERE id = $1::uuid
      FOR UPDATE
    `,
    [args.stock_level_id]
  );
  const stockLevel = stockLevelRes.rows[0] ?? null;
  if (!stockLevel) {
    throw new HttpError(409, "STOCK_LEVEL_NOT_FOUND", "Niveau de stock introuvable pour la reservation automatique");
  }

  const availableQty = Number(stockLevel.qty_total) - Number(stockLevel.qty_reserved);
  if (availableQty + 1e-9 < qtyToReserve) {
    throw new HttpError(409, "INSUFFICIENT_STOCK", "Le stock produit n'est pas encore disponible pour la reservation automatique");
  }

  await client.query(
    `
      UPDATE public.stock_levels
      SET qty_reserved = qty_reserved + $2,
          updated_at = now(),
          updated_by = $3
      WHERE id = $1::uuid
    `,
    [args.stock_level_id, qtyToReserve, args.actor_user_id]
  );

  const stockBatchRes = await client.query<{ qty_total: number; qty_reserved: number }>(
    `
      SELECT qty_total::float8 AS qty_total, qty_reserved::float8 AS qty_reserved
      FROM public.stock_batches
      WHERE id = $1::uuid AND lot_id = $2::uuid
      FOR UPDATE
    `,
    [args.stock_batch_id, args.lot_id]
  );
  const stockBatch = stockBatchRes.rows[0] ?? null;
  if (!stockBatch) {
    throw new HttpError(409, "STOCK_BATCH_NOT_FOUND", "Lot de stock introuvable pour la reservation automatique");
  }
  const batchAvailableQty = Number(stockBatch.qty_total) - Number(stockBatch.qty_reserved);
  if (batchAvailableQty + 1e-9 < qtyToReserve) {
    throw new HttpError(409, "INSUFFICIENT_LOT_STOCK", "Le lot produit n'est pas disponible pour la reservation automatique");
  }
  await client.query(
    `
      UPDATE public.stock_batches
      SET qty_reserved = qty_reserved + $2
      WHERE id = $1::uuid
    `,
    [args.stock_batch_id, qtyToReserve]
  );

  const existingReservation = await client.query<{ id: string }>(
    `
      SELECT id::text AS id
      FROM public.stock_reservations
      WHERE article_id = $1::uuid
        AND location_id = $2::uuid
        AND source_type = 'COMMANDE_LIGNE'
        AND source_id = $3
        AND lot_id = $4::uuid
        AND stock_batch_id = $5::uuid
        AND status = 'ACTIVE'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE
    `,
    [args.article_id, args.location_id, String(args.commande_ligne_id), args.lot_id, args.stock_batch_id]
  );

  const existingId = existingReservation.rows[0]?.id ?? null;
  if (existingId) {
    await client.query(
      `
        UPDATE public.stock_reservations
        SET qty_reserved = qty_reserved + $2,
            commande_ligne_id = COALESCE(commande_ligne_id, $4::bigint),
            updated_at = now(),
            updated_by = $3
        WHERE id = $1::uuid
      `,
      [existingId, qtyToReserve, args.actor_user_id, args.commande_ligne_id]
    );
    return { reservation_id: existingId, qty_reserved: qtyToReserve };
  }

  const insertReservation = await client.query<{ id: string }>(
    `
      INSERT INTO public.stock_reservations (
        article_id,
        location_id,
        qty_reserved,
        source_type,
        source_id,
        commande_ligne_id,
        status,
        lot_id,
        stock_batch_id,
        created_by,
        updated_by
      ) VALUES ($1::uuid,$2::uuid,$3,'COMMANDE_LIGNE',$4,$4::bigint,'ACTIVE',$5::uuid,$6::uuid,$7,$7)
      RETURNING id::text AS id
    `,
    [
      args.article_id,
      args.location_id,
      qtyToReserve,
      String(args.commande_ligne_id),
      args.lot_id,
      args.stock_batch_id,
      args.actor_user_id,
    ]
  );

  const reservationId = insertReservation.rows[0]?.id ?? null;
  return reservationId ? { reservation_id: reservationId, qty_reserved: qtyToReserve } : null;
}

async function resolveUnitIdForArticle(
  client: Pick<PoolClient, "query">,
  articleId: string,
  preferredUnitCode: string | null | undefined
): Promise<{ unit_id: string; unit_code: string }> {
  const preferred = preferredUnitCode?.trim() ? preferredUnitCode.trim() : null;

  let code: string | null = preferred;
  if (!code) {
    const a = await client.query<{ unite: string | null }>(
      `SELECT unite FROM public.articles WHERE id = $1::uuid LIMIT 1`,
      [articleId]
    );
    code = a.rows[0]?.unite?.trim() ? a.rows[0].unite!.trim() : null;
  }

  if (!code) {
    throw new HttpError(422, "UNIT_REQUIRED", "Veuillez renseigner l'unite pour la mise en stock");
  }

  const u = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.units WHERE code = $1::citext LIMIT 1`,
    [code]
  );
  const unitId = u.rows[0]?.id;
  if (!unitId) {
    throw new HttpError(422, "UNIT_NOT_FOUND", "Unite inconnue");
  }
  return { unit_id: unitId, unit_code: code };
}

async function resolveEmplacementByLocationId(
  client: Pick<PoolClient, "query">,
  locationId: string
): Promise<{ magasin_id: string; emplacement_id: number; location_id: string; warehouse_id: string }> {
  const res = await client.query<{ magasin_id: string; emplacement_id: number; location_id: string; warehouse_id: string; magasin_is_active: boolean }>(
    `
      SELECT
        e.magasin_id::text AS magasin_id,
        e.id::bigint AS emplacement_id,
        e.location_id::text AS location_id,
        l.warehouse_id::text AS warehouse_id,
        COALESCE(m.is_active, true) AS magasin_is_active
      FROM public.emplacements e
      JOIN public.locations l ON l.id = e.location_id
      LEFT JOIN public.magasins m ON m.id = e.magasin_id
      WHERE e.location_id = $1::uuid
      LIMIT 1
    `,
    [locationId]
  );

  const row = res.rows[0] ?? null;
  if (!row) throw new HttpError(400, "INVALID_LOCATION", "Emplacement introuvable pour ce lieu (location_id)");
  if (!row.magasin_is_active) throw new HttpError(409, "MAGASIN_INACTIVE", "Le magasin selectionne est desactive");

  return {
    magasin_id: row.magasin_id,
    emplacement_id: Number(row.emplacement_id),
    location_id: row.location_id,
    warehouse_id: row.warehouse_id,
  };
}

async function ensureStockLevel(
  client: Pick<PoolClient, "query">,
  args: {
    article_id: string;
    unit_id: string;
    warehouse_id: string;
    location_id: string;
    actor_user_id: number;
  }
): Promise<string> {
  const existing = await client.query<{ id: string; unit_id: string; warehouse_id: string }>(
    `
      SELECT
        id::text AS id,
        unit_id::text AS unit_id,
        warehouse_id::text AS warehouse_id
      FROM public.stock_levels
      WHERE article_id = $1::uuid AND location_id = $2::uuid
    `,
    [args.article_id, args.location_id]
  );
  const row = existing.rows[0] ?? null;
  if (row) {
    if (row.unit_id !== args.unit_id) throw new HttpError(409, "STOCK_LEVEL_UNIT_MISMATCH", "Stock level unit mismatch");
    if (row.warehouse_id !== args.warehouse_id) throw new HttpError(409, "STOCK_LEVEL_WAREHOUSE_MISMATCH", "Stock level warehouse mismatch");
    return row.id;
  }

  await client.query(
    `
      INSERT INTO public.stock_levels (
        article_id, unit_id, warehouse_id, location_id,
        managed_in_stock,
        created_by, updated_by
      )
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,true,$5,$5)
      ON CONFLICT (article_id, location_id) DO NOTHING
    `,
    [args.article_id, args.unit_id, args.warehouse_id, args.location_id, args.actor_user_id]
  );

  const after = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.stock_levels WHERE article_id = $1::uuid AND location_id = $2::uuid`,
    [args.article_id, args.location_id]
  );
  const id = after.rows[0]?.id;
  if (!id) throw new Error("Failed to ensure stock level");
  return id;
}

async function ensureStockBatchId(client: Pick<PoolClient, "query">, args: { stock_level_id: string; lot_id: string }): Promise<string> {
  const lot = await client.query<{ lot_code: string }>(`SELECT lot_code FROM public.lots WHERE id = $1::uuid`, [args.lot_id]);
  const lotCode = lot.rows[0]?.lot_code;
  if (!lotCode) throw new HttpError(400, "INVALID_LOT", "Lot introuvable");

  await client.query(
    `
      INSERT INTO public.stock_batches (stock_level_id, batch_code, lot_id)
      VALUES ($1::uuid,$2,$3::uuid)
      ON CONFLICT (stock_level_id, batch_code) DO NOTHING
    `,
    [args.stock_level_id, lotCode, args.lot_id]
  );

  const b = await client.query<{ id: string; lot_id: string | null }>(
    `SELECT id::text AS id, lot_id::text AS lot_id
     FROM public.stock_batches
     WHERE stock_level_id = $1::uuid AND batch_code = $2
     FOR UPDATE`,
    [args.stock_level_id, lotCode]
  );
  const row = b.rows[0] ?? null;
  const id = row?.id;
  if (!id) throw new Error("Failed to ensure stock batch");
  if (row.lot_id && row.lot_id !== args.lot_id) {
    throw new HttpError(409, "STOCK_BATCH_LOT_MISMATCH", "Le lot de stock est deja rattache a un autre lot interne");
  }
  if (!row.lot_id) {
    await client.query(`UPDATE public.stock_batches SET lot_id = $2::uuid WHERE id = $1::uuid`, [id, args.lot_id]);
  }
  return id;
}

async function insertMovementEvent(client: Pick<PoolClient, "query">, args: {
  movement_id: string;
  event_type: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  user_id: number;
}) {
  await client.query(
    `
      INSERT INTO public.stock_movement_event_log (
        stock_movement_id,
        event_type,
        old_values,
        new_values,
        user_id,
        created_by,
        updated_by
      )
      VALUES ($1::uuid,$2,$3::jsonb,$4::jsonb,$5,$5,$5)
    `,
    [args.movement_id, args.event_type, args.old_values, args.new_values, args.user_id]
  );
}

export async function repoGetOfReceiptContext(params: { of_id: number }): Promise<OfReceiptContext> {
  type OfRow = {
    id: string;
    numero: string;
    piece_technique_id: string;
    article_id: string | null;
    piece_code: string;
    piece_designation: string;
    quantite_lancee: number;
    quantite_bonne: number;
    statut: string;
    updated_at: string;
    affaire_id: number | null;
    commande_id: number | null;
    commande_ligne_id: number | null;
  };

  const ofRes = await pool.query<OfRow>(
    `
      SELECT
        o.id::text AS id,
        o.numero,
        o.piece_technique_id::text AS piece_technique_id,
        o.article_id::text AS article_id,
        pt.code AS piece_code,
        pt.designation AS piece_designation,
        o.quantite_lancee::float8 AS quantite_lancee,
        o.quantite_bonne::float8 AS quantite_bonne,
        o.statut::text AS statut,
        o.updated_at::text AS updated_at,
        o.affaire_id::bigint::int AS affaire_id,
        o.commande_id::bigint::int AS commande_id,
        o.commande_ligne_id::bigint::int AS commande_ligne_id
      FROM public.ordres_fabrication o
      JOIN public.pieces_techniques pt ON pt.id = o.piece_technique_id
      WHERE o.id = $1::bigint
      LIMIT 1
    `,
    [params.of_id]
  );
  const ofRow = ofRes.rows[0] ?? null;
  if (!ofRow) throw new HttpError(404, "OF_NOT_FOUND", "Ordre de fabrication introuvable");

  const ofId = Number(ofRow.id);
  if (!Number.isFinite(ofId)) throw new Error("Invalid OF id");

  const article = ofRow.article_id
    ? {
        id: ofRow.article_id,
        unite: (
          await pool.query<{ unite: string | null }>(`SELECT unite FROM public.articles WHERE id = $1::uuid LIMIT 1`, [ofRow.article_id])
        ).rows[0]?.unite ?? null,
      }
    : await resolveArticleForPieceTechnique(pool, ofRow.piece_technique_id);
  const outputLotsRes = await pool.query<{
    lot_id: string;
    lot_code: string;
    lot_status: string;
    qty_ok: number;
    qty_scrap: number;
    qty_rework: number;
    updated_at: string;
  }>(
    `
      SELECT
        ool.lot_id::text AS lot_id,
        l.lot_code,
        l.lot_status,
        ool.qty_ok::float8 AS qty_ok,
        ool.qty_scrap::float8 AS qty_scrap,
        ool.qty_rework::float8 AS qty_rework,
        ool.updated_at::text AS updated_at
      FROM public.of_output_lots ool
      JOIN public.lots l ON l.id = ool.lot_id
      WHERE ool.of_id = $1::bigint
      ORDER BY ool.updated_at DESC, ool.id DESC
    `,
    [params.of_id]
  );
  const existingLotsRes = await pool.query<{
    lot_id: string;
    lot_code: string;
    lot_status: string;
    qty_on_hand: number;
    updated_at: string;
  }>(
    `
      SELECT
        l.id::text AS lot_id,
        l.lot_code,
        l.lot_status,
        COALESCE(SUM(sb.qty_total), 0)::float8 AS qty_on_hand,
        l.updated_at::text AS updated_at
      FROM public.lots l
      LEFT JOIN public.stock_batches sb ON sb.lot_id = l.id
      WHERE l.article_id = $1::uuid
      GROUP BY l.id, l.lot_code, l.lot_status, l.updated_at
      ORDER BY l.updated_at DESC, l.lot_code ASC
      LIMIT 200
    `,
    [article.id]
  );

  const receivedQty = outputLotsRes.rows.reduce((acc, r) => acc + (Number.isFinite(r.qty_ok) ? r.qty_ok : 0), 0);
  const qtyOkReceivable = Math.max(0, Number(ofRow.quantite_bonne) - receivedQty);

  const defaultSetting = await pool.query<{ value_text: string | null }>(
    `SELECT value_text FROM public.erp_settings WHERE key = 'stock.default_receipt_location' LIMIT 1`
  );
  const defaultLocationId = defaultSetting.rows[0]?.value_text ?? null;

  const magasinsRes = await pool.query<{ id: string; code: string; name: string; is_active: boolean }>(
    `
      SELECT
        m.id::text AS id,
        COALESCE(m.code, m.code_magasin) AS code,
        COALESCE(m.name, m.libelle) AS name,
        m.is_active
      FROM public.magasins m
      WHERE m.is_active = true
      ORDER BY COALESCE(m.name, m.libelle) ASC, COALESCE(m.code, m.code_magasin) ASC
    `
  );

  const emplacementsRes = await pool.query<{ id: number; magasin_id: string; code: string; name: string | null; location_id: string }>(
    `
      SELECT
        e.id::bigint AS id,
        e.magasin_id::text AS magasin_id,
        e.code,
        e.name,
        e.location_id::text AS location_id
      FROM public.emplacements e
      JOIN public.magasins m ON m.id = e.magasin_id
      WHERE e.is_active = true
        AND m.is_active = true
        AND e.location_id IS NOT NULL
      ORDER BY e.magasin_id ASC, e.code ASC
    `
  );

  return {
    of: {
      id: ofId,
      numero: ofRow.numero,
      piece_technique_id: ofRow.piece_technique_id,
      piece_code: ofRow.piece_code,
      piece_designation: ofRow.piece_designation,
      quantite_lancee: Number(ofRow.quantite_lancee),
      quantite_bonne: Number(ofRow.quantite_bonne),
      statut: ofRow.statut,
      updated_at: ofRow.updated_at,
      affaire_id: ofRow.affaire_id === null ? null : Number(ofRow.affaire_id),
      commande_id: ofRow.commande_id === null ? null : Number(ofRow.commande_id),
      commande_ligne_id: ofRow.commande_ligne_id === null ? null : Number(ofRow.commande_ligne_id),
    },
    article_id: article.id,
    unite: article.unite,
    received_qty_ok: receivedQty,
    qty_ok_receivable: qtyOkReceivable,
    default_location_id: defaultLocationId,
    output_lots: outputLotsRes.rows.map((r) => ({
      lot_id: r.lot_id,
      lot_code: r.lot_code,
      lot_status: r.lot_status,
      qty_ok: Number(r.qty_ok),
      qty_scrap: Number(r.qty_scrap),
      qty_rework: Number(r.qty_rework),
      updated_at: r.updated_at,
    })),
    existing_lots: existingLotsRes.rows.map((r) => ({
      lot_id: r.lot_id,
      lot_code: r.lot_code,
      lot_status: r.lot_status,
      qty_on_hand: Number(r.qty_on_hand),
      updated_at: r.updated_at,
    })),
    locations: {
      magasins: magasinsRes.rows.map((m) => ({ id: m.id, code: m.code, name: m.name, is_active: m.is_active })),
      emplacements: emplacementsRes.rows.map((e) => ({
        id: Number(e.id),
        magasin_id: e.magasin_id,
        code: e.code,
        name: e.name,
        location_id: e.location_id,
      })),
    },
  };
}

export async function repoCreateOfReceipt(params: {
  of_id: number;
  body: OfReceiptBodyDTO;
  idempotency_key: string;
  audit: AuditContext;
}): Promise<OfReceiptResult> {
  const client = await pool.connect();
  const requestHash = receiptRequestHash(params.of_id, params.body);
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `of-receipt:${params.audit.user_id}:${params.idempotency_key}`,
    ]);

    const replayRes = await client.query<{ request_hash: string; result_payload: OfReceiptResult }>(
      `
        SELECT request_hash, result_payload
        FROM public.of_receipts
        WHERE actor_user_id = $1
          AND idempotency_key = $2
        LIMIT 1
      `,
      [params.audit.user_id, params.idempotency_key]
    );
    const replay = replayRes.rows[0] ?? null;
    if (replay) {
      if (replay.request_hash !== requestHash) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Cette cle d'idempotence a deja ete utilisee avec un contenu different."
        );
      }
      await client.query("COMMIT");
      return { ...replay.result_payload, idempotent_replay: true };
    }

    const ofRes = await client.query<{
      numero: string;
      piece_technique_id: string;
      article_id: string | null;
      affaire_id: number | null;
      commande_ligne_id: number | null;
      quantite_bonne: number;
      statut: string;
      updated_at: string;
    }>(
      `
        SELECT
          numero,
          piece_technique_id::text AS piece_technique_id,
          article_id::text AS article_id,
          affaire_id::bigint::int AS affaire_id,
          commande_ligne_id::bigint::int AS commande_ligne_id,
          quantite_bonne::float8 AS quantite_bonne,
          statut::text AS statut,
          updated_at::text AS updated_at
        FROM public.ordres_fabrication
        WHERE id = $1::bigint
        FOR UPDATE
      `,
      [params.of_id]
    );
    const ofRow = ofRes.rows[0] ?? null;
    if (!ofRow) throw new HttpError(404, "OF_NOT_FOUND", "Ordre de fabrication introuvable");

    if (Date.parse(ofRow.updated_at) !== Date.parse(params.body.expected_of_updated_at)) {
      throw new HttpError(
        409,
        "CONCURRENT_MODIFICATION",
        "L'OF a ete modifie depuis l'apercu. Rechargez les donnees avant de confirmer.",
        { expected: params.body.expected_of_updated_at, actual: ofRow.updated_at }
      );
    }

    // #170 : pas de réception sur un OF annulé/clôturé/non démarré.
    const ofStatut = ofRow.statut as OfStatut;
    if (!ofStatutAllowsReceipt(ofStatut)) {
      throw new HttpError(
        409,
        "OF_RECEIPT_STATUS_INVALID",
        `Impossible d'enregistrer une réception sur un OF au statut ${ofStatut}.`,
        { statut: ofStatut }
      );
    }

    // #170 : la réception est bornée par la quantité restante, recalculée DANS
    // la transaction après verrou de l'OF — deux réceptions concurrentes se
    // sérialisent sur ce verrou et la seconde est refusée si elle déborde.
    const receivedRes = await client.query<{ received: number }>(
      `SELECT COALESCE(SUM(qty_ok), 0)::float8 AS received FROM public.of_output_lots WHERE of_id = $1::bigint`,
      [params.of_id]
    );
    const alreadyReceived = Number(receivedRes.rows[0]?.received ?? 0);
    const receivable = Math.max(0, Number(ofRow.quantite_bonne) - alreadyReceived);
    if (params.body.qty_ok > receivable + 1e-9) {
      throw new HttpError(
        422,
        "OF_RECEIPT_EXCEEDS_RECEIVABLE",
        `Quantité reçue (${params.body.qty_ok}) supérieure au restant à réceptionner (${receivable}).`,
        { requested: params.body.qty_ok, receivable, already_received: alreadyReceived, quantite_bonne: Number(ofRow.quantite_bonne) }
      );
    }

    const article = ofRow.article_id
      ? {
          id: ofRow.article_id,
          unite: (
            await client.query<{ unite: string | null }>(`SELECT unite FROM public.articles WHERE id = $1::uuid LIMIT 1`, [ofRow.article_id])
          ).rows[0]?.unite ?? null,
        }
      : await resolveArticleForPieceTechnique(client, ofRow.piece_technique_id);
    if (params.body.article_id && params.body.article_id !== article.id) {
      throw new HttpError(400, "ARTICLE_MISMATCH", "L'article selectionne ne correspond pas a la piece technique de l'OF");
    }

    const unit = await resolveUnitIdForArticle(client, article.id, params.body.unite ?? null);
    const map = await resolveEmplacementByLocationId(client, params.body.location_id);
    const stockLevelId = await ensureStockLevel(client, {
      article_id: article.id,
      unit_id: unit.unit_id,
      warehouse_id: map.warehouse_id,
      location_id: map.location_id,
      actor_user_id: params.audit.user_id,
    });

    let lotId: string;
    let lotCode: string;
    if (params.body.lot_mode === "EXISTING") {
      const rawLotId = params.body.lot_id ?? null;
      if (!rawLotId) throw new HttpError(422, "LOT_REQUIRED", "Veuillez selectionner un lot");
      const lot = await client.query<{ id: string; lot_code: string; lot_status: string | null }>(
        `
          SELECT id::text AS id, lot_code, lot_status
          FROM public.lots
          WHERE id = $1::uuid AND article_id = $2::uuid
          LIMIT 1
        `,
        [rawLotId, article.id]
      );
      const row = lot.rows[0] ?? null;
      if (!row) throw new HttpError(400, "INVALID_LOT", "Lot introuvable pour cet article");

      const lotStatus = row.lot_status ?? "LIBERE";
      if (lotStatus !== params.body.quality_status) {
        throw new HttpError(
          409,
          "LOT_QUALITY_STATUS_MISMATCH",
          `Le lot existant est au statut ${lotStatus}; la reception demandee est ${params.body.quality_status}.`
        );
      }

      lotId = row.id;
      lotCode = row.lot_code;
    } else {
      if (params.body.lot_number?.trim()) {
        throw new HttpError(400, "LOT_CODE_SERVER_MANAGED", "Le numéro de lot interne est attribué automatiquement.");
      }
      const code = await generateTransactionalBusinessCode(client, { prefix: "LOT" });
      try {
        const ins = await client.query<{ id: string }>(
          `
            INSERT INTO public.lots (
              article_id, lot_code, lot_status, lot_status_note, notes, created_by, updated_by
            )
            VALUES ($1::uuid,$2,$3,$4,$5,$6,$6)
            RETURNING id::text AS id
          `,
          [
            article.id,
            code,
            params.body.quality_status,
            params.body.quality_reason ?? null,
            params.body.commentaire ?? null,
            params.audit.user_id,
          ]
        );
        const id = ins.rows[0]?.id;
        if (!id) throw new Error("Failed to create lot");
        lotId = id;
        lotCode = code;
      } catch (err) {
        const e = err as { code?: unknown } | null;
        if (e?.code === "23505") {
          throw new HttpError(409, "LOT_EXISTS", "Un lot avec ce numero existe deja pour cet article");
        }
        throw err;
      }
    }

    const stockBatchId = await ensureStockBatchId(client, { stock_level_id: stockLevelId, lot_id: lotId });
    const movementNo = await reserveMovementNo(client);

    const movementIns = await client.query<{ id: string }>(
      `
        INSERT INTO public.stock_movements (
          movement_type,
          article_id,
          stock_level_id,
          stock_batch_id,
          qty,
          currency,
          notes,
          user_id,
          movement_no,
          status,
          effective_at,
          source_document_type,
          source_document_id,
          reason_code,
          idempotency_key,
          created_by,
          updated_by
        )
        VALUES (
          'IN'::public.movement_type,
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4,
          'EUR',
          $5,
          $6,
          $7,
          'DRAFT',
          now(),
          'OF',
          $8,
          'OF_RECEIPT',
          $9,
          $6,
          $6
        )
        RETURNING id::text AS id
      `,
      [
        article.id,
        stockLevelId,
        stockBatchId,
        params.body.qty_ok,
        params.body.commentaire ?? null,
        params.audit.user_id,
        movementNo,
        String(params.of_id),
        `of-receipt:${params.audit.user_id}:${params.idempotency_key}`,
      ]
    );
    const movementId = movementIns.rows[0]?.id;
    if (!movementId) throw new Error("Failed to create stock movement");

    await client.query(
      `
        INSERT INTO public.stock_movement_lines (
          movement_id,
          line_no,
          article_id,
          lot_id,
          qty,
          unite,
          dst_magasin_id,
          dst_emplacement_id,
          note,
          created_by,
          updated_by
        )
        VALUES ($1::uuid,1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::bigint,$8,$9,$9)
      `,
      [
        movementId,
        article.id,
        lotId,
        params.body.qty_ok,
        unit.unit_code,
        map.magasin_id,
        map.emplacement_id,
        params.body.commentaire ?? null,
        params.audit.user_id,
      ]
    );

    await insertMovementEvent(client, {
      movement_id: movementId,
      event_type: "CREATED",
      old_values: null,
      new_values: { status: "DRAFT", movement_type: "IN", movement_no: movementNo },
      user_id: params.audit.user_id,
    });

    await client.query(
      `
        UPDATE public.stock_movements
        SET
          status = 'POSTED',
          posted_at = now(),
          posted_by = $2,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [movementId, params.audit.user_id]
    );

    await insertMovementEvent(client, {
      movement_id: movementId,
      event_type: "POSTED",
      old_values: { status: "DRAFT" },
      new_values: { status: "POSTED" },
      user_id: params.audit.user_id,
    });

    await client.query(
      `
        INSERT INTO public.of_output_lots (
          of_id,
          lot_id,
          qty_ok,
          qty_scrap,
          qty_rework,
          created_by,
          updated_by
        )
        VALUES ($1::bigint,$2::uuid,$3,$4,$5,$6,$6)
        ON CONFLICT (of_id, lot_id)
        DO UPDATE SET
          qty_ok = public.of_output_lots.qty_ok + EXCLUDED.qty_ok,
          qty_scrap = public.of_output_lots.qty_scrap + EXCLUDED.qty_scrap,
          qty_rework = public.of_output_lots.qty_rework + EXCLUDED.qty_rework,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
      `,
      [
        params.of_id,
        lotId,
        params.body.qty_ok,
        params.body.qty_scrap,
        params.body.qty_rework,
        params.audit.user_id,
      ]
    );

    let nonConformityId: string | null = null;
    if (params.body.quality_status === "BLOQUE" || params.body.qty_scrap > 0 || params.body.qty_rework > 0) {
      const ncRes = await client.query<{ id: string }>(
        `
          INSERT INTO public.non_conformity (
            affaire_id,
            of_id,
            piece_technique_id,
            lot_id,
            description,
            severity,
            status,
            detected_by,
            created_by,
            updated_by
          )
          VALUES (
            $1::bigint,
            $2::bigint,
            $3::uuid,
            $4::uuid,
            $5,
            $6::public.quality_nc_severity,
            'OPEN'::public.quality_nc_status,
            $7,
            $7,
            $7
          )
          RETURNING id::text AS id
        `,
        [
          ofRow.affaire_id,
          params.of_id,
          ofRow.piece_technique_id,
          lotId,
          params.body.quality_reason ??
            `Ecart constate a la reception de production: rebut ${params.body.qty_scrap}, retouche ${params.body.qty_rework}.`,
          params.body.quality_status === "BLOQUE" ? "MAJOR" : "MINOR",
          params.audit.user_id,
        ]
      );
      nonConformityId = ncRes.rows[0]?.id ?? null;
      if (!nonConformityId) throw new Error("Failed to create production non-conformity");
    }

    const autoReservation =
      params.body.quality_status === "LIBERE" && typeof ofRow.commande_ligne_id === "number"
        ? await reserveProducedQtyForCommandeLine(client, {
            commande_ligne_id: ofRow.commande_ligne_id,
            article_id: article.id,
            location_id: map.location_id,
            stock_level_id: stockLevelId,
            stock_batch_id: stockBatchId,
            lot_id: lotId,
            qty_ok: params.body.qty_ok,
            actor_user_id: params.audit.user_id,
          })
        : null;

    const receiptId = randomUUID();
    const receiptResult: OfReceiptResult = {
      receipt_id: receiptId,
      lot_id: lotId,
      lot_code: lotCode,
      stock_movement_id: movementId,
      movement_no: movementNo,
      qty_ok: params.body.qty_ok,
      qty_scrap: params.body.qty_scrap,
      qty_rework: params.body.qty_rework,
      quality_status: params.body.quality_status,
      reservation_id: autoReservation?.reservation_id ?? null,
      reserved_qty: autoReservation?.qty_reserved ?? 0,
      non_conformity_id: nonConformityId,
      idempotent_replay: false,
    };

    await client.query(
      `
        UPDATE public.ordres_fabrication
        SET updated_at = clock_timestamp(),
            updated_by = $2
        WHERE id = $1::bigint
      `,
      [params.of_id, params.audit.user_id]
    );

    await client.query(
      `
        INSERT INTO public.of_receipts (
          id,
          of_id,
          actor_user_id,
          idempotency_key,
          request_hash,
          request_payload,
          result_payload,
          expected_of_updated_at,
          qty_ok,
          qty_scrap,
          qty_rework,
          quality_status,
          quality_reason,
          location_id,
          lot_id,
          stock_level_id,
          stock_batch_id,
          stock_movement_id,
          reservation_id,
          non_conformity_id
        )
        VALUES (
          $1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7::jsonb,$8::timestamptz,
          $9,$10,$11,$12,$13,$14::uuid,$15::uuid,$16::uuid,$17::uuid,$18::uuid,
          $19::uuid,$20::uuid
        )
      `,
      [
        receiptId,
        params.of_id,
        params.audit.user_id,
        params.idempotency_key,
        requestHash,
        params.body,
        receiptResult,
        params.body.expected_of_updated_at,
        params.body.qty_ok,
        params.body.qty_scrap,
        params.body.qty_rework,
        params.body.quality_status,
        params.body.quality_reason ?? null,
        map.location_id,
        lotId,
        stockLevelId,
        stockBatchId,
        movementId,
        autoReservation?.reservation_id ?? null,
        nonConformityId,
      ]
    );

    await insertAuditLog(client, params.audit, {
      action: "production.of.receipt",
      entity_type: "ordres_fabrication",
      entity_id: String(params.of_id),
      details: {
        lot_id: lotId,
        lot_code: lotCode,
        qty_ok: params.body.qty_ok,
        qty_scrap: params.body.qty_scrap,
        qty_rework: params.body.qty_rework,
        quality_status: params.body.quality_status,
        quality_reason: params.body.quality_reason ?? null,
        location_id: map.location_id,
        receipt_id: receiptId,
        stock_movement_id: movementId,
        movement_no: movementNo,
        commande_ligne_id: ofRow.commande_ligne_id ?? null,
        article_id: article.id,
        auto_reservation_id: autoReservation?.reservation_id ?? null,
        auto_reserved_qty: autoReservation?.qty_reserved ?? 0,
        non_conformity_id: nonConformityId,
        idempotency_key: params.idempotency_key,
      },
    });

    await client.query("COMMIT");
    return receiptResult;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetOfTraceability(params: { of_id: number }): Promise<OfTraceability> {
  const outputLotsRes = await pool.query<{
    lot_id: string;
    lot_code: string;
    lot_status: string;
    qty_ok: number;
    qty_scrap: number;
    qty_rework: number;
    updated_at: string;
  }>(
    `
      SELECT
        ool.lot_id::text AS lot_id,
        l.lot_code,
        l.lot_status,
        ool.qty_ok::float8 AS qty_ok,
        ool.qty_scrap::float8 AS qty_scrap,
        ool.qty_rework::float8 AS qty_rework,
        ool.updated_at::text AS updated_at
      FROM public.of_output_lots ool
      JOIN public.lots l ON l.id = ool.lot_id
      WHERE ool.of_id = $1::bigint
      ORDER BY ool.updated_at DESC, ool.id DESC
    `,
    [params.of_id]
  );

  const receiptsRes = await pool.query<{
    receipt_id: string | null;
    stock_movement_id: string;
    movement_no: string | null;
    status: string;
    posted_at: string | null;
    qty: number;
    qty_scrap: number;
    qty_rework: number;
    quality_status: string | null;
    reservation_id: string | null;
    non_conformity_id: string | null;
    lot_id: string | null;
    lot_code: string | null;
    magasin_id: string | null;
    magasin_code: string | null;
    magasin_name: string | null;
    emplacement_id: number | null;
    emplacement_code: string | null;
    location_id: string | null;
  }>(
    `
      SELECT
        r.id::text AS receipt_id,
        m.id::text AS stock_movement_id,
        m.movement_no,
        m.status,
        m.posted_at::text AS posted_at,
        m.qty::float8 AS qty,
        COALESCE(r.qty_scrap, 0)::float8 AS qty_scrap,
        COALESCE(r.qty_rework, 0)::float8 AS qty_rework,
        r.quality_status,
        r.reservation_id::text AS reservation_id,
        r.non_conformity_id::text AS non_conformity_id,
        ml.lot_id::text AS lot_id,
        l.lot_code,
        ml.dst_magasin_id::text AS magasin_id,
        COALESCE(mag.code, mag.code_magasin) AS magasin_code,
        COALESCE(mag.name, mag.libelle) AS magasin_name,
        ml.dst_emplacement_id::bigint AS emplacement_id,
        e.code AS emplacement_code,
        e.location_id::text AS location_id
      FROM public.stock_movements m
      LEFT JOIN public.of_receipts r ON r.stock_movement_id = m.id
      JOIN public.stock_movement_lines ml ON ml.movement_id = m.id
      LEFT JOIN public.lots l ON l.id = ml.lot_id
      LEFT JOIN public.emplacements e ON e.id = ml.dst_emplacement_id
      LEFT JOIN public.magasins mag ON mag.id = ml.dst_magasin_id
      WHERE m.source_document_type = 'OF'
        AND m.source_document_id = $1
        AND m.movement_type = 'IN'::public.movement_type
      ORDER BY m.posted_at DESC NULLS LAST, m.effective_at DESC, m.id DESC
      LIMIT 200
    `,
    [String(params.of_id)]
  );

  return {
    output_lots: outputLotsRes.rows.map((r) => ({
      lot_id: r.lot_id,
      lot_code: r.lot_code,
      lot_status: r.lot_status,
      qty_ok: Number(r.qty_ok),
      qty_scrap: Number(r.qty_scrap),
      qty_rework: Number(r.qty_rework),
      updated_at: r.updated_at,
    })),
    receipts: receiptsRes.rows.map((r) => ({
      receipt_id: r.receipt_id,
      stock_movement_id: r.stock_movement_id,
      movement_no: r.movement_no,
      status: r.status,
      posted_at: r.posted_at,
      qty: Number(r.qty),
      qty_scrap: Number(r.qty_scrap),
      qty_rework: Number(r.qty_rework),
      quality_status: r.quality_status,
      reservation_id: r.reservation_id,
      non_conformity_id: r.non_conformity_id,
      lot_id: r.lot_id,
      lot_code: r.lot_code,
      magasin_id: r.magasin_id,
      magasin_code: r.magasin_code,
      magasin_name: r.magasin_name,
      emplacement_id: r.emplacement_id !== null ? Number(r.emplacement_id) : null,
      emplacement_code: r.emplacement_code,
      location_id: r.location_id,
    })),
  };
}
