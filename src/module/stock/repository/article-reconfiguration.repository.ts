import crypto from "node:crypto";
import type { PoolClient } from "pg";
import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoCreateNextVersion } from "../../pieces-techniques/repository/versions.repository";
import { repoConfirmStockFinishArticle } from "../../surface-finish/repository/surface-finish-resolution.repository";
import type { ArticleReconfiguration } from "../validators/article-reconfiguration.validators";
import { updateArticleSchema } from "../validators/stock.validators";
import {
  insertAuditLog, repoCreateArticleTx, repoGetArticle, queueStockArticleCreationSnapshotTx,
  type AuditContext,
  repoPreviewMaterialArticleCode, repoUpdateArticle,
} from "./stock.repository";

// Read every technical reference by identity, never by a designation or phase.
const REFERENCES = `
  SELECT piece_technique_id, piece_technique_version_id AS version_id
    FROM public.pieces_techniques_achats WHERE article_id = $1::uuid
  UNION
  SELECT parent_piece_technique_id, parent_piece_technique_version_id
    FROM public.pieces_techniques_nomenclature WHERE child_article_id = $1::uuid
  UNION
  SELECT v.piece_technique_id, g.piece_technique_version_id
    FROM public.gamme_operation_finitions f
    JOIN public.gammes g ON g.id = f.gamme_id
    JOIN public.piece_technique_versions v ON v.id = g.piece_technique_version_id
   WHERE f.article_id = $1::uuid`;

async function restoreClonedPurchaseLinksTx(client: PoolClient, sourceVersion: string, nextVersion: string) {
  // The generic version copier predates generated finish purchases. Rebuild
  // only the new draft's copies, mapping their operation FKs to the cloned
  // current gamme. Old versions and their purchase identities remain intact.
  await client.query("DELETE FROM public.pieces_techniques_achats WHERE piece_technique_version_id = $1::uuid", [nextVersion]);
  const fields = ["piece_technique_id", "phase", "famille_piece_id", "nom", "designation", "designation_2", "designation_3", "article_id",
    "fournisseur_id", "fournisseur_nom", "fournisseur_code", "quantite", "quantite_brut_mm", "longueur_mm", "coefficient_chute",
    "quantite_pieces", "prix_par_quantite", "tarif", "prix", "unite_prix", "pu_achat", "tva_achat", "total_achat_ht", "total_achat_ttc", "type_achat",
    "designation_snapshot", "source"];
  await client.query(`INSERT INTO public.pieces_techniques_achats
    (${fields.join(", ")}, piece_technique_version_id, gamme_id, gamme_operation_id)
    SELECT ${fields.map(field => `source.${field}`).join(", ")}, $2::uuid,
      CASE WHEN source.gamme_id IS NULL THEN NULL ELSE target_gamme.id END, target_operation.id
    FROM public.pieces_techniques_achats source
    LEFT JOIN public.pieces_techniques_operations source_operation ON source_operation.id = source.gamme_operation_id
    LEFT JOIN public.gammes source_gamme ON source_gamme.id = source.gamme_id
    LEFT JOIN public.gammes target_gamme ON target_gamme.piece_technique_version_id = $2::uuid AND target_gamme.is_current
    LEFT JOIN public.pieces_techniques_operations target_operation ON target_operation.gamme_id = target_gamme.id
      AND target_operation.ordre = source_operation.ordre
      AND target_operation.phase IS NOT DISTINCT FROM source_operation.phase
    WHERE source.piece_technique_version_id = $1::uuid
      AND (source.gamme_id IS NULL OR source_gamme.is_current)`, [sourceVersion, nextVersion]);
  await client.query(`UPDATE public.gamme_operation_finitions f SET achat_ligne_id = NULL
    FROM public.gammes g WHERE g.id = f.gamme_id AND g.piece_technique_version_id = $1::uuid`, [nextVersion]);
  await client.query(`UPDATE public.gamme_operation_finitions f SET achat_ligne_id = p.id
    FROM public.pieces_techniques_achats p
    WHERE p.piece_technique_version_id = $1::uuid AND p.gamme_operation_id = f.gamme_operation_id
      AND p.type_achat = 'TRAITEMENT'`, [nextVersion]);
}

export async function replaceTechnicalArticleTx(
  client: PoolClient, oldId: string, next: { id: string; designation: string; article_category: string }, audit: AuditContext,
) {
  const versions = await client.query<{ id: string; piece_technique_id: string; indice: string; statut: string }>(
    `SELECT v.id::text, v.piece_technique_id::text, v.indice, v.statut
       FROM public.piece_technique_versions v
       JOIN (${REFERENCES}) refs ON refs.version_id = v.id
      WHERE v.statut <> 'OBSOLETE'
      ORDER BY v.piece_technique_id, v.id FOR UPDATE OF v`, [oldId],
  );
  const editableIds: string[] = [];
  for (const version of versions.rows) {
    if (version.statut === "APPLICABLE") {
      const clone = await repoCreateNextVersion(version.piece_technique_id, version.id, {
        indice: version.indice, change_level: "MINOR", type_changement: "MODIFICATION",
        raison_changement: `Remplacement de l'article ${oldId} par ${next.id}`,
      }, audit, client);
      editableIds.push(clone.id);
      await restoreClonedPurchaseLinksTx(client, version.id, clone.id);
      // The shared gamme copier retains the source version on finish rows.
      await client.query(`UPDATE public.gamme_operation_finitions f
        SET piece_technique_version_id = $1::uuid FROM public.gammes g
        WHERE f.gamme_id = g.id AND g.piece_technique_version_id = $1::uuid`, [clone.id]);
    } else {
      editableIds.push(version.id);
    }
  }
  const params = [oldId, next.id, next.designation, editableIds];
  await client.query(`UPDATE public.pieces_techniques_achats
    SET article_id = $2::uuid, designation = $3, designation_snapshot = $3, updated_at = now()
    WHERE article_id = $1::uuid AND (piece_technique_version_id IS NULL OR piece_technique_version_id = ANY($4::uuid[]))`, params);
  await client.query(`UPDATE public.pieces_techniques_nomenclature
    SET child_article_id = $2::uuid, designation = $3
    WHERE child_article_id = $1::uuid AND (parent_piece_technique_version_id IS NULL OR parent_piece_technique_version_id = ANY($4::uuid[]))`, params);

  if (next.article_category === "traitement") {
    // Update both the article link and its canonical specification. Changing the
    // FK alone would leave the old process instructions on the operation.
    const finishFields = ["perimetre", "zones", "masquages", "norme", "classe", "couleur", "teinte_ral", "aspect",
      "rugosite", "durete", "exigence_corrosion", "pretraitement", "posttraitement", "controles",
      "certificat_requis", "certificat_type", "conditionnement", "unite_achat", "specification_client",
      "specification_client_version", "instructions"];
    await client.query(`UPDATE public.gamme_operation_finitions f SET
      article_id = t.article_id, finish_revision_id = t.finish_revision_id,
      spec_canonical = t.spec_canonical, spec_fingerprint = t.spec_fingerprint,
      generated_designation = $3::text, generated_comment = t.generated_comment,
      template_version = t.template_version,
      ${finishFields.map(field => `${field} = spec.${field}`).join(", ")},
      epaisseur_min = (t.spec_canonical->>'epaisseur_min_um')::numeric,
      epaisseur_nominale = (t.spec_canonical->>'epaisseur_nominale_um')::numeric,
      epaisseur_max = (t.spec_canonical->>'epaisseur_max_um')::numeric, epaisseur_unite = 'um',
      updated_at = now(), updated_by = $5
      FROM public.articles_traitement t, public.gammes g,
        LATERAL jsonb_populate_record(NULL::public.gamme_operation_finitions, t.spec_canonical) spec
      WHERE t.article_id = $2::uuid AND f.article_id = $1::uuid AND g.id = f.gamme_id
        AND g.piece_technique_version_id = ANY($4::uuid[])`, [...params, audit.user_id]);
  }
  await client.query(`UPDATE public.piece_technique_versions SET statut = 'BROUILLON',
      updated_at = now(), updated_by = $2
      WHERE id = ANY($1::uuid[])`, [editableIds, audit.user_id]);
  return { versions: editableIds, created_drafts: versions.rows.filter(v => v.statut === "APPLICABLE").length };
}

export async function repoReconfigureArticle(
  sourceId: string, body: ArticleReconfiguration, audit: AuditContext,
  actor: { role: string | null }, idempotencyKey: string, includeCosts: boolean,
) {
  const client = await db.connect();
  const key = `reconfigure:${crypto.createHash("sha256").update(idempotencyKey).digest("hex")}`;
  const hash = crypto.createHash("sha256").update(JSON.stringify({ sourceId, body, actor: audit.user_id })).digest("hex");
  let nextId: string;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    const receipt = await client.query<{ article_id: string; request_hash: string }>(
      `SELECT article_id::text, request_hash FROM public.article_create_idempotence WHERE idempotency_key = $1`, [key]);
    if (receipt.rows[0]) {
      if (receipt.rows[0].request_hash !== hash) throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette validation a déjà été utilisée pour une autre modification.");
      nextId = receipt.rows[0].article_id;
    } else {
      const source = (await client.query<{ row_version: number; code: string; designation: string; article_category: string; is_active: boolean; unite: string | null }>(
        "SELECT row_version, code, designation, article_category, is_active, unite FROM public.articles WHERE id = $1::uuid FOR UPDATE", [sourceId])).rows[0];
      if (!source) throw new HttpError(404, "NOT_FOUND", "Article introuvable.");
      if (source.row_version !== body.expected_row_version) throw new HttpError(409, "ARTICLE_VERSION_CONFLICT", "Cet article a été modifié. Rechargez sa fiche avant de recommencer.");
      if (!source.is_active) throw new HttpError(409, "ARTICLE_ARCHIVED", "Réactivez cet article avant de le reconfigurer.");
      const category = body.finish ? "traitement" : body.article!.article_category;
      if (source.article_category !== category || category === "fabrique") throw new HttpError(422, "ARTICLE_CATEGORY_CHANGED", "La reconfiguration doit conserver la catégorie de l'article.");
      let next: { id: string; designation: string; article_category: string };
      let updatedInPlace = false;
      if (body.finish) {
        next = (await repoConfirmStockFinishArticle(body.finish, audit, actor, `${key}:finish`, client)).article;
      } else {
        const configured = body.article!;
        const preview = category === "matiere" ? await repoPreviewMaterialArticleCode({
          ...configured.article_matiere, family_code: configured.family_code, dimensions: configured.article_matiere,
        }) : null;
        if (preview?.code === source.code) {
          if (body.action !== "REPLACE_ALL") throw new HttpError(422, "ARTICLE_CONFIGURATION_UNCHANGED", "Cette configuration correspond à l'article actuel. Modifiez la matière pour créer une autre référence, ou appliquez les informations à l'article actuel.");
          if (configured.material_code_preview_hash && configured.material_code_preview_hash !== preview.preview_hash) throw new HttpError(409, "MATERIAL_PREVIEW_STALE", "La configuration matière a changé. Rechargez son aperçu.");
          const { material_code_preview_hash: _hash, is_active: _active, ...patch } = configured;
          await repoUpdateArticle(sourceId, updateArticleSchema.parse({ body: {
            ...patch, designation: preview.designation, expected_row_version: body.expected_row_version,
          } }).body, audit, includeCosts, client);
          next = { id: sourceId, designation: preview.designation, article_category: category };
          updatedInPlace = true;
        } else {
          const created = await repoCreateArticleTx(client, configured, audit);
          await queueStockArticleCreationSnapshotTx(client, created, audit.user_id);
          next = created;
        }
      }
      if (next.id === sourceId && !updatedInPlace) throw new HttpError(422, "ARTICLE_CONFIGURATION_UNCHANGED", "Choisissez une nouvelle configuration pour créer un autre article.");
      nextId = next.id;
      let propagation: unknown = null;
      if (body.action === "REPLACE_ALL" && !updatedInPlace) {
        const targetUnit = (await client.query<{ unite: string | null }>(
          "SELECT unite FROM public.articles WHERE id = $1::uuid", [next.id])).rows[0];
        if (targetUnit && targetUnit.unite !== source.unite) {
          const hasReferences = await client.query<{ present: boolean }>(`SELECT EXISTS(${REFERENCES}) AS present`, [sourceId]);
          if (hasReferences.rows[0]?.present) throw new HttpError(422, "ARTICLE_REPLACEMENT_UNIT_CHANGED", "L'unité de gestion change. Conservez les deux articles et ajustez les quantités des pièces techniques avant de remplacer leur matière.");
        }
        propagation = await replaceTechnicalArticleTx(client, sourceId, next, audit);
      }
      if (!updatedInPlace) await client.query(`UPDATE public.articles SET row_version = row_version + 1, updated_at = now(), updated_by = $2,
        is_active = CASE WHEN $3 THEN false ELSE is_active END,
        archived_at = CASE WHEN $3 THEN now() ELSE archived_at END,
        archived_by = CASE WHEN $3 THEN $2 ELSE archived_by END,
        archive_reason = CASE WHEN $3 THEN $4 ELSE archive_reason END WHERE id = $1::uuid`,
      [sourceId, audit.user_id, body.action === "ARCHIVE_OLD", `Remplacé par l'article ${nextId}`]);
      await insertAuditLog(client, audit, { action: "stock.articles.reconfigure", entity_type: "articles", entity_id: sourceId,
        details: { replacement_article_id: nextId, action: body.action, propagation } });
      if (body.action === "ARCHIVE_OLD") await insertAuditLog(client, audit, {
        action: "stock.articles.archive", entity_type: "articles", entity_id: sourceId,
        details: { replacement_article_id: nextId, reason: `Remplacé par l'article ${nextId}`, references_preserved: true },
      });
      await client.query(`INSERT INTO public.article_create_idempotence (idempotency_key, request_hash, article_id) VALUES ($1,$2,$3::uuid)`, [key, hash, nextId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") throw new HttpError(409, "ARTICLE_CONFIGURATION_EXISTS", "Cette configuration existe déjà. Choisissez une configuration distincte ou utilisez l'article existant.");
    throw error;
  } finally {
    client.release();
  }
  return repoGetArticle(nextId, includeCosts);
}
