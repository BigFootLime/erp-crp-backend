import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";

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
    order_type: string | null;
    client_code: string | null;
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

export async function resolveArticleForPieceTechnique(client: Pick<PoolClient, "query">, pieceTechniqueId: string): Promise<{ id: string; unite: string | null }> {
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
    order_type: string | null;
    client_code: string | null;
  };

  const ofRes = await pool.query<OfRow>(
    `
      SELECT
        o.id::text AS id,
        o.numero,
        o.piece_technique_id::text AS piece_technique_id,
        o.article_id::text AS article_id,
        pt.code_piece AS piece_code,
        pt.designation AS piece_designation,
        o.quantite_lancee::float8 AS quantite_lancee,
        o.quantite_bonne::float8 AS quantite_bonne,
        o.statut::text AS statut,
        to_char(o.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
        o.affaire_id::bigint::int AS affaire_id,
        o.commande_id::bigint::int AS commande_id,
        o.commande_ligne_id::bigint::int AS commande_ligne_id,
        commande.order_type::text AS order_type,
        pt.code_client::text AS client_code
      FROM public.ordres_fabrication o
      JOIN public.pieces_techniques pt ON pt.id = o.piece_technique_id
      LEFT JOIN public.commande_client commande ON commande.id = o.commande_id
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
  const configuredDefaultLocationId = defaultSetting.rows[0]?.value_text ?? null;
  const internalLocationId = ofRow.order_type === "INTERNE" && ofRow.client_code
    ? (
        await pool.query<{ location_id: string }>(
          `
            SELECT emplacement.location_id::text AS location_id
            FROM public.emplacements emplacement
            JOIN public.magasins magasin ON magasin.id = emplacement.magasin_id
            WHERE COALESCE(magasin.code, magasin.code_magasin) = 'NEW-PF'
              AND emplacement.code = $1
              AND emplacement.is_active = true
              AND emplacement.location_id IS NOT NULL
            LIMIT 1
          `,
          [ofRow.client_code]
        )
      ).rows[0]?.location_id ?? null
    : null;
  const defaultLocationId = internalLocationId ?? configuredDefaultLocationId;

  const magasinsRes = await pool.query<{ id: string; code: string; name: string; is_active: boolean }>(
    `
      SELECT
        m.id::text AS id,
        m.code,
        m.name,
        m.is_active
      FROM public.magasins m
      WHERE m.is_active = true
      ORDER BY m.name ASC, m.code ASC
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
      order_type: ofRow.order_type,
      client_code: ofRow.client_code,
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
        mag.code AS magasin_code,
        mag.name AS magasin_name,
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
