// #170 — aperçu et génération récursive d'OF depuis une affaire ou en manuel
// autorisé. Les deux passent par le moteur de domaine unique
// (src/module/production/domain/of-generation.ts), le même que le lancement de
// commande #168 : aucun second moteur.

import crypto from "node:crypto";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type { AuditContext } from "./production.repository";
import type { GenerateOfsBodyDTO, OfGenerationSourceDTO, PreviewOfGenerationBodyDTO } from "../validators/production.validators";
import {
  computeOfSourceHash,
  createRecursiveOrdresFabrication,
  loadApplicableTechnicalSnapshot,
  loadFabricationGenerationTree,
  type ApplicableTechnicalSnapshot,
  type FabricationGenerationNode,
  type PurchaseRequirement,
  type Queryable,
} from "../domain/of-generation";
import { roleHasOfCapability } from "../domain/of-rbac";

async function insertAuditLog(tx: Queryable, audit: AuditContext, entry: {
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

type SnapshotShape = {
  operations?: Array<{ phase?: number; designation?: string; tp?: number; tf_unit?: number; qte?: number; coef?: number; cf_id?: string | null }>;
  achats?: Array<Record<string, unknown>>;
  documents?: Array<{ id?: string; name?: string; sha256?: string | null }>;
  version?: Record<string, unknown>;
  gamme?: Record<string, unknown> | null;
};

function plannedHours(snapshot: SnapshotShape): number {
  const ops = Array.isArray(snapshot.operations) ? snapshot.operations : [];
  const total = ops.reduce((acc, op) => {
    const tp = Number(op.tp ?? 0);
    const tf = Number(op.tf_unit ?? 0);
    const qte = Number(op.qte ?? 1);
    const coef = Number(op.coef ?? 1);
    const value = (tp + tf * qte) * coef;
    return acc + (Number.isFinite(value) ? value : 0);
  }, 0);
  return Number(total.toFixed(3));
}

type PreviewBlocker = { code: string; message: string; piece_technique_id?: string | null; structure_path?: string | null };

export type OfGenerationPreviewNode = {
  key: string;
  parent_key: string | null;
  level: number;
  piece_technique_id: string;
  code_piece: string;
  designation: string;
  quantite_par_parent: number;
  quantite_cumulee: number;
  quantite_lancee: number;
  version: Record<string, unknown> | null;
  gamme: Record<string, unknown> | null;
  snapshot_sha256: string | null;
  operations_count: number;
  planned_hours: number;
  documents: Array<{ id?: string; name?: string; sha256?: string | null }>;
  achats_count: number;
  stock: { article_id: string | null; available: number | null; missing: number | null };
};

export type OfGenerationPreview = {
  source: OfGenerationSourceDTO;
  tree: OfGenerationPreviewNode[];
  totals: {
    nodes: number;
    roots: number;
    children: number;
    max_level: number;
    operations: number;
    planned_hours: number;
    purchase_requirements: number;
  };
  purchase_requirements: PurchaseRequirement[];
  warnings: string[];
  blockers: PreviewBlocker[];
  source_hash: string | null;
  code_placeholder: string;
  readiness: { production_ready: boolean; delivery_ready: false; invoicing: "not_applicable" };
};

async function resolveAffaireContext(tx: Queryable, affaireId: number, opts: { forUpdate: boolean }) {
  const res = await tx.query<{ id: string; client_id: string | null; archived_at: string | null }>(
    `
      SELECT a.id::text AS id, a.client_id, a.archived_at::text AS archived_at
      FROM public.affaire a
      WHERE a.id = $1::bigint
      ${opts.forUpdate ? "FOR UPDATE" : ""}
    `,
    [affaireId]
  );
  const row = res.rows[0] ?? null;
  if (!row) {
    throw new HttpError(404, "AFFAIRE_NOT_FOUND", "Affaire introuvable pour la génération d'OF.");
  }
  if (row.archived_at) {
    throw new HttpError(422, "AFFAIRE_ARCHIVED", "Impossible de générer des OF depuis une affaire archivée.", {
      affaire_id: affaireId,
    });
  }
  return row;
}

function extractPurchaseRequirementsFromSnapshot(params: {
  of_id: number;
  structure_path: string;
  piece_technique_id: string;
  qty_lancee: number;
  snapshot: SnapshotShape;
}): PurchaseRequirement[] {
  const achats = Array.isArray(params.snapshot.achats) ? params.snapshot.achats : [];
  return achats.map((achat) => {
    const qtyPerPiece = Number(achat.quantite ?? 0);
    const safeQty = Number.isFinite(qtyPerPiece) ? qtyPerPiece : 0;
    return {
      of_id: params.of_id,
      structure_path: params.structure_path,
      piece_technique_id: params.piece_technique_id,
      achat_id: typeof achat.id === "string" ? achat.id : null,
      article_id: typeof achat.article_id === "string" ? achat.article_id : null,
      fournisseur_id: typeof achat.fournisseur_id === "string" ? achat.fournisseur_id : null,
      nom: typeof achat.nom === "string" ? achat.nom : null,
      designation: typeof achat.designation === "string" ? achat.designation : null,
      type_achat: typeof achat.type_achat === "string" ? achat.type_achat : null,
      qty_per_piece: safeQty,
      qty_required: Number((safeQty * params.qty_lancee).toFixed(3)),
    };
  });
}

/**
 * Aperçu sans effet de bord (#170 §6) : aucun INSERT, aucun code consommé.
 * Transaction ouverte puis ROLLBACK systématique pour garantir la lecture
 * cohérente ET l'absence totale d'écriture.
 */
export async function repoPreviewOfGeneration(params: {
  body: PreviewOfGenerationBodyDTO;
  audit: AuditContext;
}): Promise<OfGenerationPreview> {
  const source = params.body.source;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (source.type === "AFFAIRE" && source.affaire_id) {
      await resolveAffaireContext(client, source.affaire_id, { forUpdate: false });
    }

    const warnings: string[] = [];
    const blockers: PreviewBlocker[] = [];

    let tree: FabricationGenerationNode[] = [];
    try {
      tree = await loadFabricationGenerationTree(client, source.piece_technique_id);
      if (!tree.length) {
        blockers.push({ code: "PIECE_TECHNIQUE_NOT_FOUND", message: "Pièce technique introuvable ou supprimée." });
      }
    } catch (err) {
      if (err instanceof HttpError) {
        blockers.push({
          code: err.code,
          message: err.message,
          piece_technique_id: (err.details as { piece_technique_id?: string } | undefined)?.piece_technique_id ?? null,
          structure_path: (err.details as { structure_path?: string } | undefined)?.structure_path ?? null,
        });
      } else {
        throw err;
      }
    }

    const technicalByKey = new Map<string, ApplicableTechnicalSnapshot>();
    const technicalCache = new Map<string, ApplicableTechnicalSnapshot>();
    for (const node of tree) {
      const pinned = node.level === 0 ? source.piece_technique_version_id ?? null : null;
      const cacheKey = `${node.piece_technique_id}:${pinned ?? ""}`;
      try {
        let technical = technicalCache.get(cacheKey);
        if (!technical) {
          technical = await loadApplicableTechnicalSnapshot(client, node.piece_technique_id, { pinned_version_id: pinned });
          technicalCache.set(cacheKey, technical);
        }
        technicalByKey.set(node.key, technical);
      } catch (err) {
        if (err instanceof HttpError) {
          blockers.push({
            code: err.code,
            message: err.message,
            piece_technique_id: node.piece_technique_id,
            structure_path: node.key,
          });
        } else {
          throw err;
        }
      }
    }

    // Stock disponible par article (informatif).
    const articleIds = [...new Set(tree.map((n) => n.article_id).filter((v): v is string => Boolean(v)))];
    const stockByArticle = new Map<string, number>();
    if (articleIds.length > 0) {
      const stockRes = await client.query<{ article_id: string; available: number }>(
        `
          SELECT article_id::text AS article_id, COALESCE(SUM(qty_total - qty_reserved), 0)::float8 AS available
          FROM public.stock_levels
          WHERE article_id = ANY($1::uuid[])
          GROUP BY article_id
        `,
        [articleIds]
      );
      for (const row of stockRes.rows) stockByArticle.set(row.article_id, Number(row.available));
    }

    const purchaseRequirements: PurchaseRequirement[] = [];
    const previewNodes: OfGenerationPreviewNode[] = tree.map((node) => {
      const technical = technicalByKey.get(node.key) ?? null;
      const snapshot = (technical?.snapshot ?? {}) as SnapshotShape;
      const qtyLancee = Number((source.quantity * node.quantite_cumulee).toFixed(3));
      const operationsCount = Array.isArray(snapshot.operations) ? snapshot.operations.length : 0;
      if (technical && operationsCount === 0) {
        blockers.push({
          code: "PIECE_TECHNIQUE_OPERATION_REQUIRED",
          message: `La pièce ${node.code_piece} n'a aucune opération de gamme applicable.`,
          piece_technique_id: node.piece_technique_id,
          structure_path: node.key,
        });
      }
      const documents = Array.isArray(snapshot.documents) ? snapshot.documents : [];
      if (technical && documents.length === 0) {
        warnings.push(`DOCUMENT_MISSING:${node.code_piece}`);
      }
      if (technical) {
        purchaseRequirements.push(
          ...extractPurchaseRequirementsFromSnapshot({
            of_id: 0,
            structure_path: node.key,
            piece_technique_id: node.piece_technique_id,
            qty_lancee: qtyLancee,
            snapshot,
          })
        );
      }
      const available = node.article_id ? stockByArticle.get(node.article_id) ?? 0 : null;
      return {
        key: node.key,
        parent_key: node.parent_key,
        level: node.level,
        piece_technique_id: node.piece_technique_id,
        code_piece: node.code_piece,
        designation: node.designation,
        quantite_par_parent: node.quantite_par_parent,
        quantite_cumulee: node.quantite_cumulee,
        quantite_lancee: qtyLancee,
        version: (snapshot.version as Record<string, unknown> | undefined) ?? null,
        gamme: (snapshot.gamme as Record<string, unknown> | null | undefined) ?? null,
        snapshot_sha256: technical?.sha256 ?? null,
        operations_count: operationsCount,
        planned_hours: technical ? plannedHours(snapshot) : 0,
        documents: documents.map((d) => ({ id: d.id, name: d.name, sha256: d.sha256 ?? null })),
        achats_count: Array.isArray(snapshot.achats) ? snapshot.achats.length : 0,
        stock: {
          article_id: node.article_id,
          available,
          missing: available === null ? null : Math.max(0, Number((qtyLancee - available).toFixed(3))),
        },
      };
    });

    const complete = blockers.length === 0 && tree.length > 0 && technicalByKey.size === tree.length;
    const sourceHash = complete ? computeOfSourceHash(tree, technicalByKey) : null;

    await client.query("ROLLBACK");

    return {
      source,
      tree: previewNodes,
      totals: {
        nodes: previewNodes.length,
        roots: previewNodes.filter((n) => n.level === 0).length,
        children: previewNodes.filter((n) => n.level > 0).length,
        max_level: previewNodes.reduce((acc, n) => Math.max(acc, n.level), 0),
        operations: previewNodes.reduce((acc, n) => acc + n.operations_count, 0),
        planned_hours: Number(previewNodes.reduce((acc, n) => acc + n.planned_hours, 0).toFixed(3)),
        purchase_requirements: purchaseRequirements.length,
      },
      purchase_requirements: purchaseRequirements,
      warnings,
      blockers,
      source_hash: sourceHash,
      code_placeholder: "OF-AAAA-NNNNNN (attribué par le serveur à la confirmation)",
      readiness: { production_ready: complete, delivery_ready: false, invoicing: "not_applicable" },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type OfGenerationResult = {
  batch_id: string;
  root_of_id: number;
  of_ids: number[];
  root_of_ids: number[];
  child_of_ids: number[];
  total_nodes: number;
  max_level: number;
  source_hash: string;
  purchase_requirements: PurchaseRequirement[];
  idempotent_replay: boolean;
};

/**
 * Génération transactionnelle (#170 §7) : verrou source, idempotence par clé,
 * revalidation du hash source (409 si l'aperçu est périmé), moteur unique,
 * audit, commit unique. Un échec à toute profondeur annule tout sauf les
 * numéros consommés (trous acceptés, jamais réutilisés).
 */
export async function repoGenerateOfs(params: {
  body: GenerateOfsBodyDTO;
  idempotency_key: string;
  audit: AuditContext;
}): Promise<OfGenerationResult> {
  const source = params.body.source;
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(params.body)).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Idempotence : un retry identique renvoie le même batch/arbre ; une
    // réutilisation de clé avec un payload différent est refusée.
    const replay = await client.query<{ id: string; request_hash: string | null; result: unknown }>(
      `SELECT id::text AS id, request_hash, result FROM public.of_generation_batches WHERE idempotency_key = $1 FOR UPDATE`,
      [params.idempotency_key]
    );
    const replayRow = replay.rows[0] ?? null;
    if (replayRow) {
      if (replayRow.request_hash !== requestHash) {
        throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with a different payload.");
      }
      await client.query("COMMIT");
      const persisted = (replayRow.result ?? {}) as Partial<OfGenerationResult> & { of_ids?: number[] };
      return {
        batch_id: replayRow.id,
        root_of_id: Number(persisted.root_of_id ?? 0),
        of_ids: persisted.of_ids ?? [],
        root_of_ids: persisted.root_of_ids ?? [],
        child_of_ids: persisted.child_of_ids ?? [],
        total_nodes: Number(persisted.total_nodes ?? persisted.of_ids?.length ?? 0),
        max_level: Number(persisted.max_level ?? 0),
        source_hash: String(persisted.source_hash ?? ""),
        purchase_requirements: (persisted.purchase_requirements as PurchaseRequirement[] | undefined) ?? [],
        idempotent_replay: true,
      };
    }

    // Verrou de la source.
    let clientId: string | null = source.client_id ?? null;
    let affaireId: number | null = null;
    if (source.type === "AFFAIRE" && source.affaire_id) {
      const affaire = await resolveAffaireContext(client, source.affaire_id, { forUpdate: true });
      affaireId = source.affaire_id;
      clientId = clientId ?? affaire.client_id;
    } else {
      // Génération manuelle : sérialiser les générations concurrentes sur la pièce.
      const pieceLock = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM public.pieces_techniques WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE`,
        [source.piece_technique_id]
      );
      if (!pieceLock.rows[0]?.id) {
        throw new HttpError(422, "PIECE_TECHNIQUE_NOT_FOUND", "Pièce technique introuvable pour la génération d'OF.");
      }
    }

    if (params.audit.user_role !== undefined && !roleHasOfCapability(params.audit.user_role, "generate")) {
      throw new HttpError(403, "OF_GENERATE_FORBIDDEN", "Votre rôle ne permet pas de générer des OF.");
    }

    const generated = await createRecursiveOrdresFabrication(client, {
      source_type: source.type === "AFFAIRE" ? "AFFAIRE" : "MANUAL",
      commande_id: null,
      commande_numero: null,
      commande_ligne_id: null,
      livraison_affaire_id: affaireId,
      client_id: clientId,
      root_article_id: null,
      root_piece_technique_id: source.piece_technique_id,
      root_pinned_version_id: source.piece_technique_version_id ?? null,
      qty_to_produce: source.quantity,
      user_id: params.audit.user_id,
      idempotency_key: params.idempotency_key,
      request_hash: requestHash,
    });

    // La confirmation reçoit le hash de l'aperçu : si la définition a changé
    // entre-temps, tout est annulé (les numéros consommés restent des trous).
    if (generated.source_hash !== params.body.expected_source_hash) {
      throw new HttpError(
        409,
        "OF_PREVIEW_STALE",
        "La définition technique a changé depuis l'aperçu. Régénérez l'aperçu avant de confirmer.",
        { expected_source_hash: params.body.expected_source_hash, actual_source_hash: generated.source_hash }
      );
    }

    await insertAuditLog(client, params.audit, {
      action: "production.of.generate",
      entity_type: "of_generation_batches",
      entity_id: generated.batch_id,
      details: {
        source_type: source.type,
        affaire_id: affaireId,
        piece_technique_id: source.piece_technique_id,
        piece_technique_version_id: source.piece_technique_version_id ?? null,
        quantity: source.quantity,
        idempotency_key: params.idempotency_key,
        source_hash: generated.source_hash,
        of_ids: generated.ofs.map((of) => of.id),
        purchase_requirements_count: generated.purchase_requirements.length,
      },
    });

    await client.query("COMMIT");

    return {
      batch_id: generated.batch_id,
      root_of_id: generated.root_of_id,
      of_ids: generated.ofs.map((of) => of.id),
      root_of_ids: generated.ofs.filter((of) => of.parent_of_id === null).map((of) => of.id),
      child_of_ids: generated.ofs.filter((of) => of.parent_of_id !== null).map((of) => of.id),
      total_nodes: generated.ofs.length,
      max_level: generated.ofs.reduce((acc, of) => Math.max(acc, of.generation_level), 0),
      source_hash: generated.source_hash,
      purchase_requirements: generated.purchase_requirements,
      idempotent_replay: false,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
