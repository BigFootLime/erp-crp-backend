// Traçabilité industrielle 360 (#142) — automatisation « sortie matière
// comptabilisée → consommation OF ».
//
// C'est le maillon qui manquait. Avant ce module, rien en base ne reliait de
// façon prouvable un lot matière consommé à l'OF qui l'a consommé :
// `stock_movements` ne porte pas d'`of_id`, seulement une référence
// documentaire textuelle (`source_document_type` / `source_document_id`).
//
// Trois garanties :
//   1. TRANSACTIONNELLE — l'écriture se fait dans la transaction qui
//      comptabilise le mouvement. Pas de consommation sans mouvement
//      comptabilisé, pas de mouvement comptabilisé sans sa consommation.
//   2. IDEMPOTENTE — `ON CONFLICT (stock_movement_line_id) DO NOTHING`.
//      Rejouer la comptabilisation ne duplique jamais la preuve.
//   3. INDÉPENDANTE DE L'INTERFACE — aucun écran n'a besoin d'exister pour
//      que la traçabilité soit écrite.
//
// Une consommation comptabilisée ne se corrige jamais : elle se COMPENSE.

import type { PoolClient } from "pg";

type MinimalClient = Pick<PoolClient, "query">;

export type ConsumptionAutomationResult = {
  recorded: number;
  compensated: number;
  skipped_reason: string | null;
};

const EMPTY: ConsumptionAutomationResult = { recorded: 0, compensated: 0, skipped_reason: null };

/**
 * Une table absente (`42P01`, patch #142 pas encore appliqué) ne doit JAMAIS
 * faire échouer une comptabilisation de stock : la traçabilité s'ajoute au
 * flux métier, elle ne le prend pas en otage. La lacune reste visible côté
 * lecture (`coverage`), elle n'est pas silencieuse.
 */
function isMissingObject(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42501" || code === "42703";
}

/**
 * À appeler DANS la transaction de comptabilisation, juste après le passage du
 * mouvement à `POSTED`.
 */
export async function recordMaterialConsumptionOnPost(
  client: MinimalClient,
  params: { movementId: string; actorUserId: number | null; correlationId: string | null }
): Promise<ConsumptionAutomationResult> {
  try {
    const head = await client.query<{
      movement_type: string;
      status: string;
      source_document_type: string | null;
      source_document_id: string | null;
      effective_at: string;
      reversal_of_id: string | null;
    }>(
      `SELECT m.movement_type::text AS movement_type,
              m.status,
              m.source_document_type,
              m.source_document_id,
              COALESCE(m.posted_at, m.effective_at)::text AS effective_at,
              m.reversal_of_id::text AS reversal_of_id
         FROM public.stock_movements m
        WHERE m.id = $1::uuid`,
      [params.movementId]
    );

    const movement = head.rows[0] ?? null;
    if (!movement) return { ...EMPTY, skipped_reason: "movement_not_found" };
    if (movement.status !== "POSTED") return { ...EMPTY, skipped_reason: "movement_not_posted" };

    let compensated = 0;
    if (movement.reversal_of_id) {
      compensated = await compensateConsumptions(client, {
        reversedMovementId: movement.reversal_of_id,
        compensatingMovementId: params.movementId,
        actorUserId: params.actorUserId,
        correlationId: params.correlationId,
        effectiveAt: movement.effective_at,
      });
    }

    // Seule une SORTIE consomme de la matière. Une entrée, un transfert ou un
    // ajustement ne sont pas une consommation d'OF.
    const isOutbound = movement.movement_type === "OUT" || movement.movement_type === "SCRAP";
    const declaresOf =
      (movement.source_document_type ?? "").trim().toUpperCase() === "OF" &&
      /^[0-9]{1,18}$/.test((movement.source_document_id ?? "").trim());

    if (!isOutbound || !declaresOf) {
      return {
        recorded: 0,
        compensated,
        skipped_reason: compensated > 0 ? null : "not_an_of_material_issue",
      };
    }

    const ofId = (movement.source_document_id ?? "").trim();

    // L'OF déclaré doit exister : une référence textuelle vers un OF inexistant
    // est une anomalie de données, pas une consommation à enregistrer.
    const ofCheck = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.ordres_fabrication WHERE id = $1::bigint`,
      [ofId]
    );
    if (!ofCheck.rows.length) {
      return { recorded: 0, compensated, skipped_reason: "declared_of_not_found" };
    }

    // Insertion depuis les lignes du mouvement : article, lot, quantité et
    // unité viennent de l'enregistrement comptabilisé, jamais du client.
    // La réservation consommée est rattachée quand elle existe — c'est la
    // preuve la plus forte de l'engagement matière vers cet OF.
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.of_material_consumptions (
         of_id, article_id, lot_id,
         stock_movement_id, stock_movement_line_id, reservation_id,
         qty, unit_code, effective_at, status, source, correlation_id, created_by
       )
       SELECT
         $2::bigint,
         sl.article_id,
         sl.lot_id,
         sl.movement_id,
         sl.id,
         res.id,
         ABS(sl.qty),
         COALESCE(NULLIF(btrim(sl.unite), ''), NULLIF(btrim(a.unite), ''), 'U'),
         $3::timestamptz,
         'POSTED',
         CASE WHEN res.id IS NULL THEN 'STOCK_MOVEMENT_POST' ELSE 'RESERVATION_CONSUME' END,
         $4::uuid,
         $5::int
       FROM public.stock_movement_lines sl
       JOIN public.articles a ON a.id = sl.article_id
       LEFT JOIN LATERAL (
         SELECT r.id
           FROM public.stock_reservations r
          WHERE r.consumed_stock_movement_id = sl.movement_id
            AND r.lot_id = sl.lot_id
            AND r.of_id = $2::bigint
          ORDER BY r.consumed_at DESC NULLS LAST
          LIMIT 1
       ) res ON TRUE
       WHERE sl.movement_id = $1::uuid
         AND sl.lot_id IS NOT NULL
         AND sl.qty <> 0
       ON CONFLICT (stock_movement_line_id) DO NOTHING
       RETURNING id::text AS id`,
      [params.movementId, ofId, movement.effective_at, params.correlationId, params.actorUserId]
    );

    return { recorded: inserted.rows.length, compensated, skipped_reason: null };
  } catch (err) {
    if (isMissingObject(err)) {
      return { ...EMPTY, skipped_reason: "traceability_table_unavailable" };
    }
    throw err;
  }
}

/**
 * Un mouvement compensatoire annule l'effet d'un mouvement comptabilisé, il ne
 * l'efface pas. Les consommations d'origine passent donc en `COMPENSATED` et,
 * lorsque le mouvement compensatoire porte réellement la même paire
 * (article, lot), une ligne de compensation est enregistrée et corrélée.
 *
 * La correspondance article+lot n'est PAS une heuristique : elle est bornée à
 * la paire mouvement/contre-mouvement liée par la clé étrangère
 * `stock_movements.reversal_of_id`, et n'est retenue que si elle est unique.
 */
async function compensateConsumptions(
  client: MinimalClient,
  params: {
    reversedMovementId: string;
    compensatingMovementId: string;
    actorUserId: number | null;
    correlationId: string | null;
    effectiveAt: string;
  }
): Promise<number> {
  const originals = await client.query<{
    id: string;
    of_id: string;
    article_id: string;
    lot_id: string;
    unit_code: string;
  }>(
    `SELECT c.id::text AS id, c.of_id::text AS of_id, c.article_id::text AS article_id,
            c.lot_id::text AS lot_id, c.unit_code
       FROM public.of_material_consumptions c
      WHERE c.stock_movement_id = $1::uuid
        AND c.status = 'POSTED'
      FOR UPDATE`,
    [params.reversedMovementId]
  );

  if (!originals.rows.length) return 0;

  let compensated = 0;
  for (const original of originals.rows) {
    const counterpart = await client.query<{ id: string; qty: string; unite: string | null }>(
      `SELECT sl.id::text AS id, ABS(sl.qty)::text AS qty, sl.unite
         FROM public.stock_movement_lines sl
        WHERE sl.movement_id = $1::uuid
          AND sl.article_id = $2::uuid
          AND sl.lot_id = $3::uuid
          AND sl.qty <> 0`,
      [params.compensatingMovementId, original.article_id, original.lot_id]
    );

    if (counterpart.rows.length === 1) {
      const line = counterpart.rows[0];
      await client.query(
        `INSERT INTO public.of_material_consumptions (
           of_id, article_id, lot_id, stock_movement_id, stock_movement_line_id,
           qty, unit_code, effective_at, status, source, compensates_id, correlation_id, created_by
         ) VALUES (
           $1::bigint, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6::numeric, $7, $8::timestamptz, 'POSTED', 'COMPENSATION', $9::uuid, $10::uuid, $11::int
         )
         ON CONFLICT (stock_movement_line_id) DO NOTHING`,
        [
          original.of_id,
          original.article_id,
          original.lot_id,
          params.compensatingMovementId,
          line.id,
          line.qty,
          (line.unite ?? original.unit_code ?? "U").trim() || "U",
          params.effectiveAt,
          original.id,
          params.correlationId,
          params.actorUserId,
        ]
      );
    }

    await client.query(
      `UPDATE public.of_material_consumptions
          SET status = 'COMPENSATED',
              compensated_by_id = (
                SELECT c2.id FROM public.of_material_consumptions c2
                 WHERE c2.compensates_id = $1::uuid
                 LIMIT 1
              )
        WHERE id = $1::uuid`,
      [original.id]
    );
    compensated += 1;
  }

  return compensated;
}
