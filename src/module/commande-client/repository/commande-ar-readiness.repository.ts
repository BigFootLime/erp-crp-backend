import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";

type Db = Pick<PoolClient, "query">;

// A header-level event or a slot belonging to another revision cannot cover a phase.
export async function assertOrderManufacturingPlanned(db: Db, orderId: number) {
  const evidence = (
    await db.query<{ orders: number; incomplete: number }>(
      `
        WITH manufacturing AS (
          SELECT o.* FROM public.ordres_fabrication o
          LEFT JOIN public.commande_ligne l ON l.id = o.commande_ligne_id
          WHERE (o.commande_id = $1 OR l.commande_id = $1)
            AND o.statut::text <> 'ANNULE'
        ), phases AS (
          SELECT op.id, op.of_id, op.status,
            EXISTS(
              SELECT 1 FROM public.planning_events e
              WHERE e.of_operation_id = op.id
                AND e.archived_at IS NULL
                AND e.status::text <> 'CANCELLED'
                AND e.end_ts > e.start_ts
                AND (e.machine_id IS NOT NULL OR e.poste_id IS NOT NULL)
            ) OR EXISTS(
              SELECT 1 FROM public.planning_tasks t
              WHERE t.operation_id = op.id
                AND t.committed_end > t.committed_start
                AND EXISTS(
                  SELECT 1
                  FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations', '[]')) f
                  WHERE f->>'phase' = op.phase::text
                    AND f->>'type_operation' = 'SOUS_TRAITANCE'
                )
            ) AS planned
          FROM public.of_operations op
          JOIN manufacturing o ON o.id = op.of_id
          WHERE op.status::text <> 'CANCELLED'
            AND (op.revision_id IS NULL OR EXISTS (
              SELECT 1 FROM public.of_revisions r
              WHERE r.id = op.revision_id AND r.statut = 'ACTIVE'
            ))
        )
        SELECT
          count(*)::int AS orders,
          count(*) FILTER (WHERE
            o.statut::text NOT IN ('PLANIFIE', 'EN_COURS', 'EN_PAUSE', 'TERMINE', 'CLOTURE')
            OR o.technical_readiness IS DISTINCT FROM 'VALIDATED'
            OR o.technical_snapshot_sha256 IS NULL
            OR NOT EXISTS(SELECT 1 FROM phases p WHERE p.of_id = o.id)
            OR EXISTS(
              SELECT 1 FROM phases p
              WHERE p.of_id = o.id AND p.status::text <> 'DONE' AND NOT p.planned
            )
          )::int AS incomplete
        FROM manufacturing o
      `,
      [orderId],
    )
  ).rows[0];
  if (!evidence?.orders) {
    throw new HttpError(
      409,
      "PLANNING_REQUIRES_OF",
      "Aucun OF actif ne couvre cette commande.",
    );
  }
  if (evidence.incomplete) {
    throw new HttpError(
      409,
      "PLANNING_REQUIRES_PLANNED_OF",
      "Validez le dossier technique et planifiez chaque opération active de tous les OF de la commande.",
    );
  }
}

/** Validate the physical cover at issuance time, including legacy AR_PRET orders. */
export async function readOrderArCoverage(db: Db, orderId: number) {
  const coverage = (
    await db.query<{ has_of: boolean; complete: boolean }>(
      `
        WITH lines AS (
          SELECT l.id, l.quantite, l.article_id
          FROM public.commande_ligne l WHERE l.commande_id = $1
        ), manufacturing AS (
          SELECT o.* FROM public.ordres_fabrication o
          WHERE o.statut::text <> 'ANNULE'
            AND (o.commande_id = $1 OR o.commande_ligne_id IN (SELECT id FROM lines))
        ), stock AS (
          SELECT r.commande_ligne_id,
            sum(CASE
              WHEN r.source_type = 'COMMANDE_LIGNE'
                THEN greatest(r.qty_reserved - r.qty_consumed, 0)
              ELSE LEAST(greatest(r.qty_reserved - r.qty_consumed, 0), COALESCE(prepared.qty, 0))
            END) AS qty
          FROM public.stock_reservations r
          JOIN lines l ON l.id = r.commande_ligne_id
          JOIN public.articles requested ON requested.id = l.article_id
          JOIN public.articles reserved ON reserved.id = r.article_id
            AND COALESCE(reserved.root_article_id, reserved.id) = COALESCE(requested.root_article_id, requested.id)
          LEFT JOIN public.lots lot ON lot.id = r.lot_id AND lot.article_id = r.article_id
          LEFT JOIN LATERAL (
            SELECT LEAST(
              prepared_line.quantite,
              COALESCE(sum(prepared_allocation.quantite), 0)
            ) AS qty
            FROM public.bon_livraison_ligne prepared_line
            JOIN public.bon_livraison prepared_header
              ON prepared_header.id = prepared_line.bon_livraison_id
            JOIN public.bon_livraison_ligne_allocations prepared_allocation
              ON prepared_allocation.bon_livraison_ligne_id = prepared_line.id
             AND prepared_allocation.reservation_id = r.id
             AND prepared_allocation.article_id = r.article_id
             AND prepared_allocation.lot_id IS NOT DISTINCT FROM r.lot_id
             AND prepared_allocation.location_id IS NOT DISTINCT FROM r.location_id
             AND prepared_allocation.stock_level_id IS NOT DISTINCT FROM r.stock_level_id
             AND prepared_allocation.stock_batch_id IS NOT DISTINCT FROM r.stock_batch_id
             AND prepared_allocation.commande_ligne_affaire_allocation_id
               IS NOT DISTINCT FROM r.commande_ligne_affaire_allocation_id
            WHERE prepared_line.id = r.bon_livraison_ligne_id
              AND prepared_line.commande_ligne_id = l.id
              AND prepared_header.statut = 'READY'
            GROUP BY prepared_line.quantite
          ) prepared ON r.source_type = 'BON_LIVRAISON_LIGNE'
          WHERE r.status = 'ACTIVE'
            -- Preparing a BL deliberately changes the reservation source from
            -- COMMANDE_LIGNE to BON_LIVRAISON_LIGNE. It remains physical cover
            -- for this order line only while the prepared allocation still
            -- points at that exact reservation. Do not count arbitrary BL or
            -- component reservations merely because they carry a line id.
            AND (
              (r.source_type = 'COMMANDE_LIGNE' AND r.source_id = l.id::text)
              OR (
                r.source_type = 'BON_LIVRAISON_LIGNE'
                AND r.bon_livraison_ligne_id IS NOT NULL
                AND r.source_id = r.bon_livraison_ligne_id::text
                AND COALESCE(prepared.qty, 0) > 0
              )
            )
            AND (r.expires_at IS NULL OR r.expires_at > statement_timestamp())
            AND ((r.lot_id IS NULL AND NOT reserved.lot_tracking) OR (
              lot.lot_status = 'LIBERE'
              AND (lot.expiry_at IS NULL OR lot.expiry_at >= current_date)
              AND (lot.client_proprietaire_id IS NULL OR lot.client_proprietaire_id = (
                SELECT client_id FROM public.commande_client WHERE id = $1
              ))
            ))
          GROUP BY r.commande_ligne_id
        ), made AS (
          SELECT o.commande_ligne_id,
            sum(greatest(o.quantite_lancee - o.quantite_rebut - greatest(
              o.quantite_bonne,
              coalesce((SELECT sum(out.qty_ok) FROM public.of_output_lots out WHERE out.of_id = o.id), 0)
            ), 0)) qty
          FROM manufacturing o
          WHERE o.parent_of_id IS NULL AND o.statut::text NOT IN ('TERMINE', 'CLOTURE')
          GROUP BY o.commande_ligne_id
        ), delivered AS (
          SELECT bl.commande_ligne_id, sum(bl.quantite) qty
          FROM public.bon_livraison_ligne bl
          JOIN public.bon_livraison h ON h.id = bl.bon_livraison_id
          WHERE bl.commande_ligne_id IN (SELECT id FROM lines)
            AND h.statut IN ('SHIPPED', 'DELIVERED')
          GROUP BY bl.commande_ligne_id
        )
        SELECT
          EXISTS(SELECT 1 FROM manufacturing) AS has_of,
          EXISTS(SELECT 1 FROM lines) AND NOT EXISTS(
            SELECT 1 FROM lines l
            LEFT JOIN stock s ON s.commande_ligne_id = l.id
            LEFT JOIN made m ON m.commande_ligne_id = l.id
            LEFT JOIN delivered d ON d.commande_ligne_id = l.id
            WHERE l.quantite <= 0
              OR greatest(l.quantite - COALESCE(d.qty, 0), 0) > COALESCE(s.qty, 0) + COALESCE(m.qty, 0)
          ) AS complete
      `,
      [orderId],
    )
  ).rows[0];
  return coverage;
}

export async function assertOrderArReady(db: Db, orderId: number) {
  const coverage = await readOrderArCoverage(db, orderId);
  if (coverage?.has_of) await assertOrderManufacturingPlanned(db, orderId);
  if (!coverage?.complete) {
    throw new HttpError(
      409,
      "COMMAND_AR_COVERAGE_REQUIRED",
      "Chaque ligne restant à livrer doit être couverte par du stock réservé ou par un OF préparé et planifié.",
    );
  }
}
