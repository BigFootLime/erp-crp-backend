import { pieceClientCodeSql } from "./stock-article-projection";
import type { PoolClient } from "pg";
import crypto from "node:crypto";

import db from "../../../config/database";
import { generatePieceTechniqueBusinessCode } from "../../../shared/codes/code-generator.service";
import { generateStockLotCode } from "../../../shared/codes/stock-lot-code.service";
import { HttpError } from "../../../utils/httpError";
import type { HistoricalStockImport } from "../types/stock.types";
import type { HistoricalImportBodyDTO } from "../validators/stock.validators";
import {
  beginStockCommand,
  completeStockCommand,
  ensureStockBatchId,
  ensureStockLevel,
  ensureArticleStockManaged,
  getEmplacementMapping,
  insertAuditLog,
  insertMovementEvent,
  reserveMovementNo,
  resolveUnitIdForArticle,
} from "./stock-movement-core.repository";
import type { AuditContext } from "./stock-movement-core.repository";
import { normalizedArticleCategorySql, repoCreateArticleTx } from "./stock-article-lifecycle.repository";
import { defaultFamilyCodeForCategory } from "./stock-material-referentials.repository";

export type StockOpeningReferenceInput = {
  key: string;
  article_id: string;
  magasin_code: string;
  emplacement_code: string;
};

export type StockOpeningReferenceResolution = {
  key: string;
  article_id: string;
  magasin_id: string | null;
  emplacement_id: number | null;
  issue: { code: string; message: string } | null;
};

export async function repoResolveStockOpeningReferences(
  inputs: StockOpeningReferenceInput[]
): Promise<Map<string, StockOpeningReferenceResolution>> {
  if (inputs.length === 0) return new Map();

  const result = await db.query<{
    key: string;
    article_id: string;
    article_found: boolean;
    article_active: boolean | null;
    stock_managed: boolean | null;
    magasin_id: string | null;
    magasin_matches: number | string | null;
    magasin_active: boolean | null;
    emplacement_id: number | null;
    emplacement_matches: number | string | null;
    emplacement_active: boolean | null;
    allow_inbound: boolean | null;
    location_id: string | null;
    warehouse_id: string | null;
  }>(
    `
      WITH requested AS (
        SELECT
          item.key,
          item.article_id::uuid AS article_id,
          item.magasin_code,
          item.emplacement_code
        FROM jsonb_to_recordset($1::jsonb) AS item(
          key text,
          article_id text,
          magasin_code text,
          emplacement_code text
        )
      )
      SELECT
        requested.key,
        requested.article_id::text AS article_id,
        (article.id IS NOT NULL) AS article_found,
        article.is_active AS article_active,
        article.stock_managed,
        magasin.id::text AS magasin_id,
        COALESCE(magasin.matches, 0) AS magasin_matches,
        magasin.is_active AS magasin_active,
        emplacement.id::int AS emplacement_id,
        COALESCE(emplacement.matches, 0) AS emplacement_matches,
        emplacement.is_active AS emplacement_active,
        emplacement.allow_inbound,
        emplacement.location_id::text AS location_id,
        location.warehouse_id::text AS warehouse_id
      FROM requested
      LEFT JOIN public.articles article ON article.id = requested.article_id
      LEFT JOIN LATERAL (
        SELECT
          candidate.id,
          COALESCE(candidate.is_active, candidate.actif, false) AS is_active,
          count(*) OVER ()::int AS matches
        FROM public.magasins candidate
        WHERE upper(btrim(COALESCE(candidate.code, candidate.code_magasin))) =
              upper(btrim(requested.magasin_code))
        ORDER BY candidate.id
        LIMIT 1
      ) magasin ON true
      LEFT JOIN LATERAL (
        SELECT
          candidate.id,
          candidate.is_active,
          candidate.allow_inbound,
          candidate.location_id,
          count(*) OVER ()::int AS matches
        FROM public.emplacements candidate
        WHERE candidate.magasin_id = magasin.id
          AND upper(btrim(candidate.code)) = upper(btrim(requested.emplacement_code))
        ORDER BY candidate.id
        LIMIT 1
      ) emplacement ON true
      LEFT JOIN public.locations location ON location.id = emplacement.location_id
      ORDER BY requested.key
    `,
    [JSON.stringify(inputs)]
  );

  return new Map(result.rows.map((row) => {
    let issue: StockOpeningReferenceResolution["issue"] = null;
    const magasinMatches = Number(row.magasin_matches ?? 0);
    const emplacementMatches = Number(row.emplacement_matches ?? 0);

    if (!row.article_found) {
      issue = { code: "STOCK_ARTICLE_NOT_FOUND", message: "L’article CERP rapproché est introuvable." };
    } else if (!row.article_active) {
      issue = { code: "STOCK_ARTICLE_INACTIVE", message: "L’article CERP rapproché est inactif." };
    } else if (!row.stock_managed) {
      issue = { code: "STOCK_ARTICLE_NOT_MANAGED", message: "L’article CERP n’est pas géré en stock." };
    } else if (magasinMatches === 0) {
      issue = { code: "STOCK_MAGASIN_NOT_FOUND", message: "Le code magasin CERP est introuvable." };
    } else if (magasinMatches > 1) {
      issue = { code: "STOCK_MAGASIN_AMBIGUOUS", message: "Le code magasin CERP correspond à plusieurs magasins." };
    } else if (!row.magasin_active) {
      issue = { code: "STOCK_MAGASIN_INACTIVE", message: "Le magasin CERP est inactif." };
    } else if (emplacementMatches === 0) {
      issue = { code: "STOCK_EMPLACEMENT_NOT_FOUND", message: "Le code emplacement CERP est introuvable dans ce magasin." };
    } else if (emplacementMatches > 1) {
      issue = { code: "STOCK_EMPLACEMENT_AMBIGUOUS", message: "Le code emplacement CERP correspond à plusieurs emplacements." };
    } else if (!row.emplacement_active) {
      issue = { code: "STOCK_EMPLACEMENT_INACTIVE", message: "L’emplacement CERP est inactif." };
    } else if (!row.allow_inbound) {
      issue = { code: "STOCK_EMPLACEMENT_INBOUND_REFUSED", message: "L’emplacement CERP refuse les entrées de stock." };
    } else if (!row.location_id || !row.warehouse_id) {
      issue = { code: "STOCK_EMPLACEMENT_NOT_MAPPED", message: "L’emplacement CERP n’est pas relié au référentiel physique de stock." };
    }

    return [row.key, {
      key: row.key,
      article_id: row.article_id,
      magasin_id: row.magasin_id,
      emplacement_id: row.emplacement_id,
      issue,
    }];
  }));
}

async function ensureHistoricalPositionTx(client: PoolClient, kind: "PF" | "MP", shelf: string, audit: AuditContext) {
  const magasinCode = `OLD-${kind}`;
  const magasin = await client.query<{ id: string; warehouse_id: string | null; code: string }>(`SELECT id::text AS id, warehouse_id::text AS warehouse_id, COALESCE(code, code_magasin)::text AS code FROM public.magasins WHERE code = $1 FOR NO KEY UPDATE`, [magasinCode]);
  const magasinId = magasin.rows[0]?.id;
  if (!magasinId) throw new HttpError(503, "STOCK_SCHEMA_UPGRADE_REQUIRED", "Les magasins OLD-PF et OLD-MP doivent être créés par le patch #446.");
  let emplacement = await client.query<{ id: number }>(`SELECT id::int AS id FROM public.emplacements WHERE magasin_id = $1::uuid AND code = $2 FOR NO KEY UPDATE`, [magasinId, shelf]);
  let emplacementId = emplacement.rows[0]?.id;
  if (!emplacementId) {
    emplacement = await client.query<{ id: number }>(
      `INSERT INTO public.emplacements (magasin_id, code, name, is_scrap, is_active, location_type, allow_inbound, allow_outbound, restrictions, created_by, updated_by)
       VALUES ($1::uuid,$2,$2,false,true,'STORAGE',true,true,'{}'::jsonb,$3,$3) RETURNING id::int AS id`,
      [magasinId, shelf, audit.user_id]
    );
    emplacementId = emplacement.rows[0]?.id;
  }
  if (!emplacementId) throw new Error("Unable to create historical shelf");
  const warehouseId = magasin.rows[0]?.warehouse_id;
  if (!warehouseId) throw new HttpError(503, "STOCK_SCHEMA_UPGRADE_REQUIRED", "Le magasin OLD doit être lié à son entrepôt.");
  const locationCode = `${magasin.rows[0]?.code}-${shelf}`;
  let locationId = (await client.query<{ id: string }>(`SELECT id::text AS id FROM public.locations WHERE warehouse_id=$1::uuid AND code=$2 LIMIT 1`, [warehouseId, locationCode])).rows[0]?.id;
  if (!locationId) {
    locationId = (await client.query<{ id: string }>(`INSERT INTO public.locations (warehouse_id, code, description) VALUES ($1::uuid,$2,$3) RETURNING id::text AS id`, [warehouseId, locationCode, `Emplacement ${shelf}`])).rows[0]?.id;
  }
  if (!locationId) throw new Error("Unable to create historical stock location");
  await client.query(`UPDATE public.emplacements SET location_id=$2::uuid, updated_at=now(), updated_by=$3 WHERE id=$1::bigint AND location_id IS NULL`, [emplacementId, locationId, audit.user_id]);
  const map = await getEmplacementMapping(client, magasinId, emplacementId, "dst");
  return { magasinId, emplacementId, ...map };
}

/**
 * OLD recovery/import scaffolding is intentionally excluded from creation-PDF
 * automation: an import may materialize many historical technical roots, and
 * emitting a GED snapshot for each would create incidental mass archive output.
 */
async function ensureHistoricalPieceTechniqueTx(client: PoolClient, input: { clientNumber: string; reference: string; indice: string | null; designation: string }, audit: AuditContext) {
  const customer = await client.query<{ client_id: string; client_code: string; company_name: string | null }>(
    `SELECT client_id::text AS client_id, client_code, company_name FROM public.clients WHERE client_code = $1 OR client_id = $1 LIMIT 1 FOR UPDATE`, [input.clientNumber]
  );
  const c = customer.rows[0];
  if (!c) throw new HttpError(422, "CLIENT_NOT_FOUND", "Le numéro client doit correspondre à un client existant.");
  const indice = input.indice?.trim() || "NA";
  const code = await generatePieceTechniqueBusinessCode(client, { clientId: c.client_id, planReference: input.reference, indiceExterne: indice });
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`historical-pt:${code}`]);
  const existing = await client.query<{ id: string }>(`SELECT id::text AS id FROM public.pieces_techniques WHERE code_piece = $1 LIMIT 1`, [code]);
  if (existing.rows[0]?.id) return existing.rows[0].id;
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO public.pieces_techniques (id, root_piece_technique_id, version_number, client_id, created_by, updated_by, famille_id, name_piece, code_piece, designation, prix_unitaire, statut, en_fabrication, code_client, client_name)
     VALUES ($1::uuid,$1::uuid,1,$2,$3,$3,NULL,$4,$5,$4,0,'DRAFT',false,$6,$7)`,
    [id, c.client_id, audit.user_id, input.designation, code, c.client_code, c.company_name]
  );
  await client.query(
    `INSERT INTO public.piece_technique_versions (piece_technique_id, indice, plan_reference, indice_externe_original, indice_externe_normalise, version_interne, code_metier, statut, is_current, raison_changement, motif_modification, created_by, updated_by)
     VALUES ($1::uuid,$2,$3,$4,$2,1,$5,'BROUILLON',false,'Reprise historique OLD','Reprise historique OLD',$6,$6)`,
    [id, indice, input.reference, input.indice ?? null, code, audit.user_id]
  );
  await client.query(`INSERT INTO public.pieces_techniques_historique (piece_technique_id, user_id, ancien_statut, nouveau_statut, commentaire) VALUES ($1::uuid,$2,NULL,'DRAFT','Création par reprise historique OLD')`, [id, audit.user_id]);
  return id;
}

/**
 * Creates one OLD opening movement in the caller's transaction.
 *
 * This is deliberately transaction-neutral: the cutover coordinator owns the
 * commit together with its crosswalk and audit records.  The public endpoint
 * continues to use {@link repoCreateHistoricalImport}, which owns its own
 * transaction.
 */
export async function repoCreateHistoricalImportTx(client: PoolClient, body: HistoricalImportBodyDTO, audit: AuditContext, idempotencyKey: string): Promise<HistoricalStockImport> {
    // A debit that creates a remnant holds stock rows before allocating a lot.
    // Serialize OLD material openings with that workflow before taking any stock lock.
    if (body.kind === "MP") {
      await client.query("SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE");
    }
    const command = await beginStockCommand(client, { audit, idempotency_key: idempotencyKey, command_type: "MOVEMENT_CREATE", request_payload: { historical_import: body } });
    if (command.existing) {
      const data = command.existing.result_payload as HistoricalStockImport | null;
      if (!data) throw new Error("Historical import receipt has no result");
      return { ...data, replayed: true };
    }
    let articleId: string;
    let shelf: string;
    if (body.kind === "MP") {
      if (body.article_id) articleId = body.article_id;
      else if (body.article) articleId = (await repoCreateArticleTx(client, body.article, audit)).id;
      else throw new HttpError(400, "ARTICLE_REQUIRED", "Article matière requis.");
      const a = await client.query<{ category: string; nuance: string | null }>(`SELECT a.article_category::text AS category, n.code AS nuance FROM public.articles a LEFT JOIN public.articles_matiere am ON am.article_id=a.id LEFT JOIN public.stock_nuances n ON n.id=am.nuance_id WHERE a.id=$1::uuid FOR SHARE OF a`, [articleId]);
      if (a.rows[0]?.category !== "matiere") throw new HttpError(422, "MP_ARTICLE_REQUIRED", "L'import MP requiert un article matière première.");
      shelf = body.historical_shelf?.trim() || a.rows[0]?.nuance?.trim() || "SANS-NUANCE";
    } else {
      if (body.article_id) {
        const selected = await client.query<{ id: string; category: string; is_active: boolean; piece_technique_id: string | null; client_code: string | null }>(
          `SELECT a.id::text AS id, ${normalizedArticleCategorySql("a.article_category")} AS category,
                  a.is_active, a.piece_technique_id::text AS piece_technique_id, ${pieceClientCodeSql()} AS client_code
           FROM public.articles a
           LEFT JOIN public.pieces_techniques pt ON pt.id = a.piece_technique_id
           LEFT JOIN public.clients piece_client ON piece_client.client_id = pt.client_id
           WHERE a.id = $1::uuid
           FOR UPDATE OF a`,
          [body.article_id]
        );
        const article = selected.rows[0];
        if (!article) throw new HttpError(422, "PF_ARTICLE_NOT_FOUND", "L'article PF sélectionné est introuvable.");
        if (article.category !== "fabrique" || !article.piece_technique_id) {
          throw new HttpError(422, "PF_ARTICLE_REQUIRED", "La reprise PF requiert un article fabriqué relié à une pièce technique.");
        }
        if (!article.is_active) throw new HttpError(422, "PF_ARTICLE_INACTIVE", "L'article PF sélectionné est inactif.");
        if ((article.client_code ?? "").trim().toLowerCase() !== body.client_number.trim().toLowerCase()) {
          throw new HttpError(422, "PF_ARTICLE_CLIENT_MISMATCH", "L'article PF sélectionné n'appartient pas au client indiqué.");
        }
        articleId = article.id;
      } else {
        if (!body.reference || !body.designation) throw new HttpError(400, "PF_ARTICLE_DETAILS_REQUIRED", "Référence et désignation PF requises.");
        const ptId = await ensureHistoricalPieceTechniqueTx(client, { clientNumber: body.client_number, reference: body.reference, indice: body.indice ?? null, designation: body.designation }, audit);
        const existing = await client.query<{ id: string }>(`SELECT id::text AS id FROM public.articles WHERE piece_technique_id=$1::uuid LIMIT 1 FOR UPDATE`, [ptId]);
        if (existing.rows[0]?.id) articleId = existing.rows[0].id;
        else {
          const family = body.family_code ?? defaultFamilyCodeForCategory("fabrique");
          const historicalClient = (await client.query<{client_id:string}>("SELECT client_id FROM public.pieces_techniques WHERE id=$1::uuid",[ptId])).rows[0]?.client_id;
          if(!historicalClient)throw new HttpError(422,"ARTICLE_CLIENT_REQUIRED","La reprise doit identifier le client de cet article fini.");
          articleId = (await repoCreateArticleTx(client, { designation: body.designation, article_type: "PIECE_TECHNIQUE", article_category: "fabrique", article_categories: ["piece_finie_fabriquee"], commercial_scope:"CLIENTS", client_ids:[historicalClient], family_code: family, piece_technique_id: ptId, stock_managed: true, lot_tracking: true, is_sold: true, is_active: true, status: "VALIDE" }, audit)).id;
        }
      }
      shelf = body.historical_shelf?.trim() || body.client_number.trim();
    }
    await ensureArticleStockManaged(client, articleId);
    let historicalTechnicalVersionId: string | null = null;
    if (body.kind === "PF" && body.technical_version_id) {
      const selectedVersion = await client.query<{ id: string }>(
        `SELECT version.id::text AS id
         FROM public.articles article
         JOIN public.piece_technique_versions version
           ON version.piece_technique_id = article.piece_technique_id
         WHERE article.id = $1::uuid AND version.id = $2::uuid
         FOR SHARE OF article, version`,
        [articleId, body.technical_version_id]
      );
      if (!selectedVersion.rows[0]?.id) {
        throw new HttpError(422, "PF_TECHNICAL_VERSION_MISMATCH", "La version technique sélectionnée ne correspond pas à l'article fini.");
      }
      historicalTechnicalVersionId = selectedVersion.rows[0].id;
    } else if (body.kind === "PF") {
      historicalTechnicalVersionId = (await client.query<{ id: string }>(
          `SELECT version.id::text AS id
           FROM public.articles article
           JOIN public.piece_technique_versions version
             ON version.piece_technique_id = article.piece_technique_id
           WHERE article.id = $1::uuid
           ORDER BY
             (version.statut = 'APPLICABLE') DESC,
             version.is_current DESC,
             version.version_interne DESC,
             version.created_at DESC
           LIMIT 1`,
          [articleId]
        )).rows[0]?.id ?? null;
    }
    const position = await ensureHistoricalPositionTx(client, body.kind, shelf, audit);
    const lotCode = await generateStockLotCode(client, body.kind === "MP" ? "matiere" : "fabrique");
    const traceSequence = await client.query<{ value: string }>(`SELECT nextval('public.stock_trace_code_446_seq')::text AS value`);
    const trace = (traceSequence.rows[0]?.value ?? "0").padStart(6, "0");
    // Default only new lots. Existing command receipts still use the original request.
    const lotStatus = body.historical_lot_status ?? "LIBERE";
    const lot = await client.query<{ id: string }>(`INSERT INTO public.lots (article_id, lot_code, supplier_lot_code, notes, material_properties, stock_trace_code, qr_payload, origin_stock_scope, source_scope, stock_scope, lot_status, piece_technique_version_id, client_proprietaire_id, created_by, updated_by) VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6,$7,'OLD','OLD','OLD',$8,$9::uuid,$10::varchar,$11,$11) RETURNING id::text AS id`, [articleId, lotCode, body.supplier_lot_code ?? (body.kind === "MP" ? body.lot_number : null), body.notes ?? null, JSON.stringify(body.historical_traceability ?? {}), trace, `CERP-STOCK:${trace}`, lotStatus, historicalTechnicalVersionId, body.owner_client_id ?? null, audit.user_id]);
    const lotId = lot.rows[0]?.id;
    if (!lotId) throw new Error("Unable to create historical lot");
    const refs: Array<["OF" | "MP_LOT" | "TRAITEMENT_LOT", string[]]> = body.kind === "PF"
      ? [["OF", body.of_affaire_refs], ["MP_LOT", body.mp_lot_refs], ["TRAITEMENT_LOT", body.traitement_lot_refs]]
      : [["MP_LOT", [body.lot_number]]];
    for (const [type, values] of refs) for (const value of values) await client.query(`INSERT INTO public.stock_lot_trace_references (lot_id, reference_type, reference_value, created_by) VALUES ($1::uuid,$2,$3,$4) ON CONFLICT DO NOTHING`, [lotId, type, value, audit.user_id]);
    if (body.historical_lot_reference) await client.query(`INSERT INTO public.stock_lot_trace_references (lot_id, reference_type, reference_value, created_by) VALUES ($1::uuid,'HISTORICAL_LOT',$2,$3) ON CONFLICT DO NOTHING`, [lotId, body.historical_lot_reference, audit.user_id]);
    const suppliedUnit = body.unite ?? null;
    const unitId = await resolveUnitIdForArticle(client, articleId, suppliedUnit);
    if (body.kind === "PF" && suppliedUnit) {
      const articleUnitId = await resolveUnitIdForArticle(client, articleId, null);
      if (unitId !== articleUnitId) {
        throw new HttpError(422, "PF_ARTICLE_UNIT_MISMATCH", "L'unité du stock historique ne correspond pas à l'unité de l'article fini.");
      }
    }
    const levelId = await ensureStockLevel(client, { article_id: articleId, unit_id: unitId, warehouse_id: position.warehouse_id, location_id: position.location_id, actor_user_id: audit.user_id });
    const batchId = await ensureStockBatchId(client, { stock_level_id: levelId, lot_id: lotId });
    const movementNo = await reserveMovementNo(client);
    const movement = await client.query<{ id: string }>(`INSERT INTO public.stock_movements (movement_no,movement_type,status,article_id,stock_level_id,stock_batch_id,qty,currency,effective_at,posted_at,posted_by,source_document_type,reason_code,notes,correlation_id,user_id,created_by,updated_by) VALUES ($1,'IN','POSTED',$2::uuid,$3::uuid,$4::uuid,$5,'EUR',now(),now(),$6,'CERP_HISTORICAL_OPENING','HISTORICAL_OPENING',$7,$8::uuid,$6,$6,$6) RETURNING id::text AS id`, [movementNo, articleId, levelId, batchId, body.quantity, audit.user_id, body.notes ?? null, command.correlation_id]);
    const movementId = movement.rows[0]?.id;
    if (!movementId) throw new Error("Unable to post historical opening movement");
    await client.query(`INSERT INTO public.stock_movement_lines (movement_id,line_no,article_id,lot_id,qty,unite,dst_magasin_id,dst_emplacement_id,created_by,updated_by) VALUES ($1::uuid,1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::bigint,$8,$8)`, [movementId, articleId, lotId, body.quantity, body.unite ?? null, position.magasinId, position.emplacementId, audit.user_id]);
    await insertMovementEvent(client, { movement_id: movementId, event_type: "CREATED_POSTED", old_values: null, new_values: { status: "POSTED", source: "CERP_HISTORICAL_OPENING" }, user_id: audit.user_id });
    const result: HistoricalStockImport = { article_id: articleId, lot_id: lotId, lot_code: lotCode, movement_id: movementId, stock_trace_code: trace, qr_payload: `CERP-STOCK:${trace}`, replayed: false };
    await insertAuditLog(client, audit, { action: "stock.historical-import.create", entity_type: "stock_movements", entity_id: movementId, details: { kind: body.kind, article_id: articleId, lot_id: lotId, stock_scope: "OLD" } });
    await completeStockCommand(client, { audit, command, command_type: "MOVEMENT_CREATE", resource_type: "stock_movement", resource_id: movementId, result_payload: result });
    return result;
}

/** Endpoint-safe wrapper retaining the established standalone transaction. */
export async function repoCreateHistoricalImport(body: HistoricalImportBodyDTO, audit: AuditContext, idempotencyKey: string): Promise<HistoricalStockImport> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await repoCreateHistoricalImportTx(client, body, audit, idempotencyKey);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
