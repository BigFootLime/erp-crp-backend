import crypto from "node:crypto";

import pool from "../../../config/database";
import { queueCreationPdfArchive } from "../../../shared/authoritative-documents/authoritative-document.service";
import { buildTechnicalPieceCreationSnapshotInput } from "../../../shared/authoritative-documents/technical-piece-creation-snapshot";
import { HttpError } from "../../../utils/httpError";
import {
  queueStockArticleCreationSnapshotTx,
  repoCreateArticleTx,
  type AuditContext,
} from "../../stock/repository/stock.repository";
import type { CreateQuickTechnicalPieceBodyDTO } from "../validators/commande-client.validators";

export type QuickTechnicalPieceResult = {
  piece_technique_id: string;
  piece_technique_version_id: string;
  article_id: string;
  article_code: string;
  reference: string;
  indice_client: string;
  designation: string;
  technical_status: "BROUILLON";
  manufacturing_mode: "SIMPLE" | "ASSEMBLY";
  assembly_supply_strategy: "MAKE_TO_ORDER" | "INTERNAL_CONTRACT";
};

export async function repoCreateQuickTechnicalPiece(
  body: CreateQuickTechnicalPieceBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<QuickTechnicalPieceResult> {
  const client = await pool.connect();
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('commande-quick-piece'), hashtext($1))",
      [idempotencyKey]
    );

    const replay = await client.query<QuickTechnicalPieceResult & { request_hash: string }>(
      `SELECT i.request_hash,
              i.piece_technique_id::text AS piece_technique_id,
              i.piece_technique_version_id::text AS piece_technique_version_id,
              i.article_id::text AS article_id,
              a.code AS article_code,
              p.code_piece AS reference,
              v.indice AS indice_client,
              p.designation,
              'BROUILLON'::text AS technical_status,
              v.manufacturing_mode,
              v.assembly_supply_strategy
         FROM public.commande_quick_piece_idempotence i
         JOIN public.pieces_techniques p ON p.id = i.piece_technique_id
         JOIN public.piece_technique_versions v ON v.id = i.piece_technique_version_id
         JOIN public.articles a ON a.id = i.article_id
        WHERE i.idempotency_key = $1
        FOR UPDATE OF i`,
      [idempotencyKey]
    );
    const existingReplay = replay.rows[0];
    if (existingReplay) {
      if (existingReplay.request_hash !== requestHash) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Cette création a déjà été utilisée avec des informations différentes."
        );
      }
      await client.query("COMMIT");
      const { request_hash: _requestHash, ...result } = existingReplay;
      return result;
    }

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('commande-quick-piece-reference'), hashtext($1))",
      [`${body.client_id}:${body.reference.toUpperCase()}`]
    );
    const duplicate = await client.query<{ id: string }>(
      `SELECT id::text AS id
         FROM public.pieces_techniques
        WHERE client_id = $1
          AND upper(trim(code_piece)) = upper(trim($2))
          AND parent_piece_technique_id IS NULL
        LIMIT 1`,
      [body.client_id, body.reference]
    );
    if (duplicate.rows[0]) {
      throw new HttpError(
        409,
        "TECHNICAL_PIECE_ALREADY_EXISTS",
        "Cette référence existe déjà pour ce client. Choisissez la pièce existante."
      );
    }

    const clientRow = await client.query<{ company_name: string | null }>(
      "SELECT company_name FROM public.clients WHERE client_id = $1 LIMIT 1",
      [body.client_id]
    );
    if (!clientRow.rows[0]) {
      throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");
    }

    const pieceId = crypto.randomUUID();
    const pieceInsert = await client.query<{ updated_at: string }>(
      `INSERT INTO public.pieces_techniques (
         id, article_id, root_piece_technique_id, parent_piece_technique_id,
         version_number, client_id, created_by, updated_by, famille_id,
         name_piece, code_piece, designation, designation_2, prix_unitaire,
         statut, en_fabrication, cycle, cycle_fabrication, code_client,
         client_name, ensemble
       ) VALUES (
         $1::uuid, NULL, $1::uuid, NULL,
         1, $2::varchar(3), $3, $3, NULL,
         $4, $5, $4, NULL, 0,
         'ACTIVE', false, NULL, NULL, $2::text,
         $6, false
       )
       RETURNING updated_at::text AS updated_at`,
      [pieceId, body.client_id, audit.user_id, body.designation, body.reference, clientRow.rows[0].company_name]
    );

    const versionId = crypto.randomUUID();
    const planReference = body.plan_reference?.trim() || body.reference;
    await client.query(
      `INSERT INTO public.piece_technique_versions (
         id, piece_technique_id, indice, plan_reference,
         indice_externe_original, indice_externe_normalise,
         version_interne, code_metier, statut, is_current,
         raison_changement, motif_modification, commentaire_revision,
         created_by, updated_by, manufacturing_mode, assembly_supply_strategy
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, $4::text,
         $3::text, upper(regexp_replace($3::text, '[^A-Za-z0-9]+', '', 'g')),
         1, concat($4::text, '-', $3::text, '-R01'), 'BROUILLON', false,
         'Création depuis une commande client', 'Création depuis une commande client',
         jsonb_build_object('source', 'COMMANDE_REÇUE'), $5, $5, $6, $7
       )`,
      [
        versionId,
        pieceId,
        body.indice_client,
        planReference,
        audit.user_id,
        body.manufacturing_mode,
        body.assembly_supply_strategy,
      ]
    );

    const article = await repoCreateArticleTx(
      client,
      {
        designation: body.designation,
        article_type: "PIECE_TECHNIQUE",
        article_category: "fabrique",
        article_categories: ["piece_finie_fabriquee"],
        family_code: "PT",
        status: "VALIDE",
        projet_id: null,
        stock_managed: true,
        piece_technique_id: pieceId,
        unite: "u",
        lot_tracking: true,
        is_sold: true,
        is_active: true,
      },
      audit
    );
    await queueStockArticleCreationSnapshotTx(client, article, audit.user_id);

    const pieceRevision = pieceInsert.rows[0]?.updated_at;
    if (!pieceRevision) throw new Error("QUICK_TECHNICAL_PIECE_REVISION_MISSING");
    await queueCreationPdfArchive(client, buildTechnicalPieceCreationSnapshotInput({
      id: pieceId,
      code: body.reference,
      designation: body.designation,
      clientId: body.client_id,
      clientName: clientRow.rows[0].company_name,
      status: "ACTIVE",
      sourceRevision: pieceRevision,
      actorUserId: audit.user_id,
      articleId: article.id,
      familyId: null,
      pieceVersion: 1,
      planReference,
      externalIndex: body.indice_client,
      internalVersion: 1,
    }));

    await client.query(
      `INSERT INTO public.commande_quick_piece_idempotence (
         idempotency_key, request_hash, piece_technique_id,
         piece_technique_version_id, article_id
       ) VALUES ($1,$2,$3::uuid,$4::uuid,$5::uuid)`,
      [idempotencyKey, requestHash, pieceId, versionId, article.id]
    );
    await client.query("COMMIT");
    return {
      piece_technique_id: pieceId,
      piece_technique_version_id: versionId,
      article_id: article.id,
      article_code: article.code,
      reference: body.reference,
      indice_client: body.indice_client,
      designation: body.designation,
      technical_status: "BROUILLON",
      manufacturing_mode: body.manufacturing_mode,
      assembly_supply_strategy: body.assembly_supply_strategy,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
