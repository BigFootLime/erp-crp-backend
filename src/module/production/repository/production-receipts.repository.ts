import type { PoolClient } from "pg";
import crypto from "node:crypto";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type { AuditContext } from "./production.repository";
import type { OfReceiptBodyDTO } from "../validators/production.validators";

export type OfReceiptContext = {
  of: {
    id: number;
    numero: string;
    piece_technique_id: string;
    piece_code: string;
    piece_designation: string;
    quantite_lancee: number;
    quantite_bonne: number;
  };
  article_id: string;
  unite: string | null;
  received_qty_ok: number;
  qty_ok_receivable: number;
  default_location_id: string | null;
  output_lots: Array<{
    lot_id: string;
    lot_code: string;
    qty_ok: number;
    updated_at: string;
  }>;
  locations: {
    magasins: Array<{ id: string; code: string; name: string; is_active: boolean }>;
    emplacements: Array<{ id: number; magasin_id: string; code: string; name: string | null; location_id: string }>;
  };
};

export type OfReceiptResult = {
  lot_id: string;
  lot_code: string;
  stock_movement_id: string;
  movement_no: string;
  qty_ok: number;
};

export type OfTraceability = {
  output_lots: OfReceiptContext["output_lots"];
  receipts: Array<{
    stock_movement_id: string;
    movement_no: string | null;
    status: string;
    posted_at: string | null;
    qty: number;
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
      INSERT INTO public.stock_batches (stock_level_id, batch_code)
      VALUES ($1::uuid,$2)
      ON CONFLICT (stock_level_id, batch_code) DO NOTHING
    `,
    [args.stock_level_id, lotCode]
  );

  const b = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.stock_batches WHERE stock_level_id = $1::uuid AND batch_code = $2`,
    [args.stock_level_id, lotCode]
  );
  const id = b.rows[0]?.id;
  if (!id) throw new Error("Failed to ensure stock batch");
  return id;
}

function formatYyyyMmDd(d: Date): string {
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function generateLotCode(ofNumero: string): string {
  const date = formatYyyyMmDd(new Date());
  const suffix = crypto.randomBytes(3).toString("hex");
  const base = `FG-${ofNumero}-${date}-${suffix}`;
  return base.length <= 80 ? base : base.slice(0, 80);
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
    piece_code: string;
    piece_designation: string;
    quantite_lancee: number;
    quantite_bonne: number;
  };

  const ofRes = await pool.query<OfRow>(
    `
      SELECT
        o.id::text AS id,
        o.numero,
        o.piece_technique_id::text AS piece_technique_id,
        pt.code AS piece_code,
        pt.designation AS piece_designation,
        o.quantite_lancee::float8 AS quantite_lancee,
        o.quantite_bonne::float8 AS quantite_bonne
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

  const article = await resolveArticleForPieceTechnique(pool, ofRow.piece_technique_id);
  const outputLotsRes = await pool.query<{ lot_id: string; lot_code: string; qty_ok: number; updated_at: string }>(
    `
      SELECT
        ool.lot_id::text AS lot_id,
        l.lot_code,
        ool.qty_ok::float8 AS qty_ok,
        ool.updated_at::text AS updated_at
      FROM public.of_output_lots ool
      JOIN public.lots l ON l.id = ool.lot_id
      WHERE ool.of_id = $1::bigint
      ORDER BY ool.updated_at DESC, ool.id DESC
    `,
    [params.of_id]
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
    },
    article_id: article.id,
    unite: article.unite,
    received_qty_ok: receivedQty,
    qty_ok_receivable: qtyOkReceivable,
    default_location_id: defaultLocationId,
    output_lots: outputLotsRes.rows.map((r) => ({
      lot_id: r.lot_id,
      lot_code: r.lot_code,
      qty_ok: Number(r.qty_ok),
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

export async function repoCreateOfReceipt(params: { of_id: number; body: OfReceiptBodyDTO; audit: AuditContext }): Promise<OfReceiptResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ofRes = await client.query<{ numero: string; piece_technique_id: string; quantite_bonne: number }>(
      `
        SELECT
          numero,
          piece_technique_id::text AS piece_technique_id,
          quantite_bonne::float8 AS quantite_bonne
        FROM public.ordres_fabrication
        WHERE id = $1::bigint
        FOR UPDATE
      `,
      [params.of_id]
    );
    const ofRow = ofRes.rows[0] ?? null;
    if (!ofRow) throw new HttpError(404, "OF_NOT_FOUND", "Ordre de fabrication introuvable");

    const article = await resolveArticleForPieceTechnique(client, ofRow.piece_technique_id);
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
      if (lotStatus === "BLOQUE" || lotStatus === "EN_ATTENTE" || lotStatus === "QUARANTAINE") {
        throw new HttpError(409, "LOT_NOT_CONSUMABLE", `Ce lot n'est pas consommable (statut: ${lotStatus})`);
      }

      lotId = row.id;
      lotCode = row.lot_code;
    } else {
      const requested = params.body.lot_number?.trim() ? params.body.lot_number.trim() : null;
      const code = requested ?? generateLotCode(ofRow.numero);
      try {
        const ins = await client.query<{ id: string }>(
          `
            INSERT INTO public.lots (article_id, lot_code, notes, created_by, updated_by)
            VALUES ($1::uuid,$2,$3,$4,$4)
            RETURNING id::text AS id
          `,
          [article.id, code, params.body.commentaire ?? null, params.audit.user_id]
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
          $6,
          $6
        )
        RETURNING id::text AS id
      `,
      [article.id, stockLevelId, stockBatchId, params.body.qty_ok, params.body.commentaire ?? null, params.audit.user_id, movementNo, String(params.of_id)]
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
        VALUES ($1::bigint,$2::uuid,$3,0,0,$4,$4)
        ON CONFLICT (of_id, lot_id)
        DO UPDATE SET
          qty_ok = public.of_output_lots.qty_ok + EXCLUDED.qty_ok,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
      `,
      [params.of_id, lotId, params.body.qty_ok, params.audit.user_id]
    );

    await insertAuditLog(client, params.audit, {
      action: "production.of.receipt",
      entity_type: "ordres_fabrication",
      entity_id: String(params.of_id),
      details: {
        lot_id: lotId,
        lot_code: lotCode,
        qty_ok: params.body.qty_ok,
        location_id: map.location_id,
        stock_movement_id: movementId,
        movement_no: movementNo,
      },
    });

    await client.query("COMMIT");
    return {
      lot_id: lotId,
      lot_code: lotCode,
      stock_movement_id: movementId,
      movement_no: movementNo,
      qty_ok: params.body.qty_ok,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoGetOfTraceability(params: { of_id: number }): Promise<OfTraceability> {
  const outputLotsRes = await pool.query<{ lot_id: string; lot_code: string; qty_ok: number; updated_at: string }>(
    `
      SELECT
        ool.lot_id::text AS lot_id,
        l.lot_code,
        ool.qty_ok::float8 AS qty_ok,
        ool.updated_at::text AS updated_at
      FROM public.of_output_lots ool
      JOIN public.lots l ON l.id = ool.lot_id
      WHERE ool.of_id = $1::bigint
      ORDER BY ool.updated_at DESC, ool.id DESC
    `,
    [params.of_id]
  );

  const receiptsRes = await pool.query<{
    stock_movement_id: string;
    movement_no: string | null;
    status: string;
    posted_at: string | null;
    qty: number;
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
        m.id::text AS stock_movement_id,
        m.movement_no,
        m.status,
        m.posted_at::text AS posted_at,
        m.qty::float8 AS qty,
        ml.lot_id::text AS lot_id,
        l.lot_code,
        ml.dst_magasin_id::text AS magasin_id,
        COALESCE(mag.code, mag.code_magasin) AS magasin_code,
        COALESCE(mag.name, mag.libelle) AS magasin_name,
        ml.dst_emplacement_id::bigint AS emplacement_id,
        e.code AS emplacement_code,
        e.location_id::text AS location_id
      FROM public.stock_movements m
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
      qty_ok: Number(r.qty_ok),
      updated_at: r.updated_at,
    })),
    receipts: receiptsRes.rows.map((r) => ({
      stock_movement_id: r.stock_movement_id,
      movement_no: r.movement_no,
      status: r.status,
      posted_at: r.posted_at,
      qty: Number(r.qty),
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
