// Moteur unique de génération récursive des OF (#55/#141/#170).
//
// Ce module de domaine est LE service partagé exigé par #170 : le lancement de
// commande (commande-client), l'action contrôlée depuis l'affaire et
// l'endpoint manuel autorisé passent tous par createRecursiveOrdresFabrication.
// Il a été déplacé depuis commande-client.repository.ts (#55/#168) sans créer
// de second moteur ; les durcissements #170 sont :
//   - cycle de nomenclature détecté explicitement avec chemin complet (422),
//   - profondeur bornée avec refus explicite au-delà (422),
//   - lignes de nomenclature filtrées par la version applicable du parent
//     (cohérence arbre généré ↔ snapshot figé),
//   - snapshot enrichi (achats, documents avec hash) pour la preuve industrielle,
//   - hash source + clé d'idempotence + résultat persistés sur le batch.
//
// Un composant présent dans plusieurs branches produit UN OF PAR OCCURRENCE
// (clé = chemin technique complet). Aucun regroupement implicite.

import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { generateTransactionalBusinessCode } from "../../../shared/codes/code-generator.service";

export type Queryable = Pick<PoolClient, "query">;

function toInt(value: unknown, label = "id"): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

export const HARD_MAX_GENERATION_DEPTH = 50;

export type FabricationGenerationNode = {
  key: string;
  parent_key: string | null;
  bom_line_id: string | null;
  parent_piece_technique_id: string | null;
  piece_technique_id: string;
  article_id: string | null;
  code_piece: string;
  designation: string;
  version_number: number;
  level: number;
  ordre_affichage: number;
  quantite_par_parent: number;
  quantite_cumulee: number;
};

type RawTreeRow = FabricationGenerationNode & { is_cycle?: boolean | null };

/**
 * Charge l'arbre de fabrication (sous-pièces fabriquées uniquement) depuis la
 * nomenclature versionnée. Les lignes de nomenclature rattachées à une version
 * précise ne sont suivies que lorsque cette version est la version APPLICABLE
 * du parent ; les lignes historiques sans version restent suivies (compat).
 *
 * Refus explicites (#170 §6) :
 *  - cycle direct ou indirect → 422 BOM_CYCLE_DETECTED avec le chemin complet ;
 *  - profondeur au-delà de HARD_MAX_GENERATION_DEPTH → 422 OF_MAX_DEPTH_EXCEEDED.
 */
export async function loadFabricationGenerationTree(
  tx: Queryable,
  pieceTechniqueId: string,
  maxDepth = HARD_MAX_GENERATION_DEPTH
): Promise<FabricationGenerationNode[]> {
  const depth = Math.max(1, Math.min(HARD_MAX_GENERATION_DEPTH, Math.trunc(maxDepth)));
  const res = await tx.query<RawTreeRow>(
    `
      WITH RECURSIVE tree AS (
        SELECT
          NULL::uuid AS bom_line_id,
          NULL::uuid AS parent_piece_technique_id,
          p.id AS piece_technique_id,
          p.article_id,
          p.code_piece,
          p.designation,
          p.version_number,
          0::int AS level,
          ARRAY[p.id]::uuid[] AS path_ids,
          ARRAY[0]::int[] AS order_path,
          0::int AS ordre_affichage,
          1::numeric AS quantite_par_parent,
          1::numeric AS quantite_cumulee,
          false AS is_cycle
        FROM public.pieces_techniques p
        WHERE p.id = $1::uuid
          AND p.deleted_at IS NULL

        UNION ALL

        SELECT
          n.id AS bom_line_id,
          n.parent_piece_technique_id,
          child.id AS piece_technique_id,
          child.article_id,
          child.code_piece,
          child.designation,
          child.version_number,
          tree.level + 1 AS level,
          tree.path_ids || child.id AS path_ids,
          tree.order_path || n.rang AS order_path,
          n.rang::int AS ordre_affichage,
          n.quantite AS quantite_par_parent,
          tree.quantite_cumulee * n.quantite AS quantite_cumulee,
          child.id = ANY(tree.path_ids) AS is_cycle
        FROM tree
        JOIN public.pieces_techniques_nomenclature n
          ON n.parent_piece_technique_id = tree.piece_technique_id
        JOIN public.pieces_techniques child
          ON child.id = n.child_piece_technique_id
         AND child.deleted_at IS NULL
        LEFT JOIN LATERAL (
          SELECT pv.id
          FROM public.piece_technique_versions pv
          WHERE pv.piece_technique_id = tree.piece_technique_id
            AND pv.statut = 'APPLICABLE'
            AND (pv.date_effet IS NULL OR pv.date_effet <= CURRENT_DATE)
          ORDER BY pv.date_effet DESC NULLS LAST, pv.version_interne DESC NULLS LAST, pv.created_at DESC
          LIMIT 1
        ) av ON true
        WHERE tree.level < $2::int
          AND NOT tree.is_cycle
          AND (n.parent_piece_technique_version_id IS NULL OR n.parent_piece_technique_version_id = av.id)
      )
      SELECT
        array_to_string(path_ids::text[], '/') AS key,
        CASE
          WHEN array_length(path_ids, 1) > 1
            THEN array_to_string(path_ids[1:(array_length(path_ids, 1) - 1)]::text[], '/')
          ELSE NULL
        END AS parent_key,
        bom_line_id::text AS bom_line_id,
        parent_piece_technique_id::text AS parent_piece_technique_id,
        piece_technique_id::text AS piece_technique_id,
        article_id::text AS article_id,
        code_piece,
        designation,
        version_number::int AS version_number,
        level,
        ordre_affichage,
        quantite_par_parent::float8 AS quantite_par_parent,
        quantite_cumulee::float8 AS quantite_cumulee,
        is_cycle
      FROM tree
      ORDER BY order_path ASC, piece_technique_id ASC
    `,
    [pieceTechniqueId, depth + 1]
  );

  const cycleRow = res.rows.find((row) => row.is_cycle === true);
  if (cycleRow) {
    throw new HttpError(
      422,
      "BOM_CYCLE_DETECTED",
      `Cycle de nomenclature détecté sur la pièce ${cycleRow.code_piece} (chemin: ${cycleRow.key})`,
      { piece_technique_id: cycleRow.piece_technique_id, code_piece: cycleRow.code_piece, structure_path: cycleRow.key }
    );
  }

  const tooDeep = res.rows.find((row) => Number(row.level) > depth);
  if (tooDeep) {
    throw new HttpError(
      422,
      "OF_MAX_DEPTH_EXCEEDED",
      `L'arborescence de fabrication dépasse la profondeur maximale autorisée (${depth}).`,
      { max_depth: depth, structure_path: tooDeep.key }
    );
  }

  return res.rows
    .filter((row) => row.is_cycle !== true && Number(row.level) <= depth)
    .map((row) => ({
      key: row.key,
      parent_key: row.parent_key,
      bom_line_id: row.bom_line_id,
      parent_piece_technique_id: row.parent_piece_technique_id,
      piece_technique_id: row.piece_technique_id,
      article_id: row.article_id,
      code_piece: row.code_piece,
      designation: row.designation,
      version_number: Number(row.version_number),
      level: Number(row.level),
      ordre_affichage: Number(row.ordre_affichage),
      quantite_par_parent: Number(row.quantite_par_parent),
      quantite_cumulee: Number(row.quantite_cumulee),
    }));
}

export async function allocateOrdreFabricationId(tx: Queryable): Promise<number> {
  const idRes = await tx.query<{ of_id: string }>(
    `SELECT nextval(pg_get_serial_sequence('public.ordres_fabrication','id'))::text AS of_id`
  );
  return toInt(idRes.rows[0]?.of_id, "ordres_fabrication.id");
}

export async function copyPieceOperationsToOf(tx: Queryable, params: {
  of_id: number;
  piece_technique_id: string;
  gamme_id: string | null;
}): Promise<number> {
  const operationsInsert = await tx.query(
    `
      INSERT INTO public.of_operations (
        of_id,
        phase,
        designation,
        cf_id,
        poste_id,
        machine_id,
        hourly_rate_applied,
        tp,
        tf_unit,
        qte,
        coef,
        temps_total_planned,
        status,
        notes,
        source_piece_operation_id
      )
      SELECT
        $1::bigint AS of_id,
        pto.phase,
        pto.designation,
        pto.cf_id,
        NULL::uuid AS poste_id,
        NULL::uuid AS machine_id,
        COALESCE(pto.taux_horaire, 0)::numeric(12,2) AS hourly_rate_applied,
        COALESCE(pto.tp, 0)::numeric(12,3) AS tp,
        COALESCE(pto.tf_unit, 0)::numeric(12,3) AS tf_unit,
        COALESCE(pto.qte, 1)::numeric(12,3) AS qte,
        COALESCE(pto.coef, 1)::numeric(10,3) AS coef,
        ROUND((COALESCE(pto.tp,0) + COALESCE(pto.tf_unit,0) * COALESCE(pto.qte,1)) * COALESCE(pto.coef,1), 3)::numeric(12,3) AS temps_total_planned,
        'TODO'::of_operation_status AS status,
        pto.designation_2 AS notes,
        pto.id AS source_piece_operation_id
      FROM public.pieces_techniques_operations pto
      WHERE pto.piece_technique_id = $2::uuid
        AND (pto.gamme_id = $3::uuid OR ($3::uuid IS NULL AND pto.gamme_id IS NULL))
      ORDER BY pto.phase ASC, pto.id ASC
    `,
    [params.of_id, params.piece_technique_id, params.gamme_id]
  );

  return operationsInsert.rowCount ?? 0;
}

export type ApplicableTechnicalSnapshot = {
  version_id: string;
  gamme_id: string | null;
  version_interne: number | null;
  snapshot: unknown;
  sha256: string;
};

/**
 * Sélectionne la version applicable (ou valide une version épinglée) DANS la
 * transaction de génération, puis fige toutes les données de fabrication dans
 * un snapshot hashable : pièce, version, gamme, opérations, nomenclature,
 * achats/matières/sous-traitance et documents (nom + hash). Partagé par le
 * lancement de commande, la génération affaire/manuelle et l'OF direct : aucun
 * chemin ne contourne la même porte de version.
 */
export async function loadApplicableTechnicalSnapshot(
  tx: Queryable,
  pieceTechniqueId: string,
  opts?: { pinned_version_id?: string | null }
): Promise<ApplicableTechnicalSnapshot> {
  const pinned = opts?.pinned_version_id ?? null;
  const versionRes = await tx.query<{
    version_id: string;
    gamme_id: string | null;
    version_interne: number | null;
  }>(
    `
      SELECT v.id::text AS version_id,
             g.id::text AS gamme_id,
             v.version_interne
      FROM public.piece_technique_versions v
      LEFT JOIN public.gammes g
        ON g.piece_technique_version_id = v.id
       AND g.is_current = true
      WHERE v.piece_technique_id = $1::uuid
        AND v.statut = 'APPLICABLE'
        AND (v.date_effet IS NULL OR v.date_effet <= CURRENT_DATE)
      ORDER BY v.date_effet DESC NULLS LAST, v.version_interne DESC NULLS LAST, v.created_at DESC
      LIMIT 1
    `,
    [pieceTechniqueId]
  );
  const version = versionRes.rows[0] ?? null;
  if (!version) {
    throw new HttpError(
      422,
      "VERSION_NOT_APPLICABLE",
      `La pièce technique ${pieceTechniqueId} ne possède pas de version applicable pour générer un OF.`
    );
  }
  if (pinned && version.version_id !== pinned) {
    throw new HttpError(
      409,
      "OF_VERSION_CONFLICT",
      "La version technique épinglée n'est plus la version applicable de la pièce. Rechargez l'aperçu.",
      { pinned_version_id: pinned, applicable_version_id: version.version_id }
    );
  }

  const snapshotRes = await tx.query<{ snapshot: unknown }>(
    `
      SELECT jsonb_build_object(
        'piece', jsonb_build_object('id', pt.id::text, 'code', pt.code_piece, 'designation', pt.designation),
        'version', jsonb_build_object(
          'id', v.id::text,
          'indice_externe', v.indice,
          'version_interne', v.version_interne,
          'plan_reference', v.plan_reference,
          'code_metier', v.code_metier,
          'date_effet', v.date_effet
        ),
        'gamme', CASE WHEN g.id IS NULL THEN NULL ELSE jsonb_build_object('id', g.id::text, 'code', g.code, 'designation', g.designation) END,
        'operations', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', op.id::text, 'phase', op.phase, 'designation', op.designation,
            'cf_id', op.cf_id::text, 'taux_horaire', op.taux_horaire,
            'tp', op.tp, 'tf_unit', op.tf_unit, 'qte', op.qte, 'coef', op.coef
          ) ORDER BY op.phase, op.id)
          FROM public.pieces_techniques_operations op
          WHERE op.piece_technique_id = pt.id
            AND (op.gamme_id = g.id OR (g.id IS NULL AND op.gamme_id IS NULL))
        ), '[]'::jsonb),
        'nomenclature', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', bom.id::text,
            'child_piece_technique_id', bom.child_piece_technique_id::text,
            'child_piece_technique_version_id', bom.child_piece_technique_version_id::text,
            'child_article_id', bom.child_article_id::text,
            'quantite', bom.quantite,
            'repere', bom.repere
          ) ORDER BY bom.rang, bom.id)
          FROM public.pieces_techniques_nomenclature bom
          WHERE bom.parent_piece_technique_id = pt.id
            AND (bom.parent_piece_technique_version_id = v.id OR bom.parent_piece_technique_version_id IS NULL)
        ), '[]'::jsonb),
        'achats', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', pa.id::text,
            'phase', pa.phase,
            'nom', pa.nom,
            'designation', pa.designation,
            'article_id', pa.article_id::text,
            'fournisseur_id', pa.fournisseur_id::text,
            'fournisseur_nom', pa.fournisseur_nom,
            'quantite', pa.quantite,
            'quantite_pieces', pa.quantite_pieces,
            'pu_achat', pa.pu_achat,
            'unite_prix', pa.unite_prix,
            'type_achat', pa.type_achat
          ) ORDER BY pa.phase NULLS LAST, pa.id)
          FROM public.pieces_techniques_achats pa
          WHERE pa.piece_technique_id = pt.id
        ), '[]'::jsonb),
        'documents', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', doc.id::text, 'name', doc.original_name, 'mime_type', doc.mime_type, 'sha256', doc.sha256
          ) ORDER BY doc.created_at, doc.id)
          FROM public.pieces_techniques_documents doc
          WHERE doc.piece_technique_id = pt.id AND doc.removed_at IS NULL
        ), '[]'::jsonb)
      ) AS snapshot
      FROM public.pieces_techniques pt
      JOIN public.piece_technique_versions v ON v.id = $2::uuid
      LEFT JOIN public.gammes g ON g.id = $3::uuid
      WHERE pt.id = $1::uuid
    `,
    [pieceTechniqueId, version.version_id, version.gamme_id]
  );
  const snapshot = snapshotRes.rows[0]?.snapshot;
  if (!snapshot) {
    throw new HttpError(422, "TECHNICAL_DATA_INCOMPLETE", "Impossible de figer les données techniques de l'OF.");
  }
  return {
    ...version,
    snapshot,
    sha256: crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  };
}

/**
 * Hash déterministe de la définition source réellement retenue pour un arbre :
 * l'aperçu le publie, la confirmation le revalide (409 si la définition a
 * changé entre-temps), le batch le persiste.
 */
export function computeOfSourceHash(
  tree: readonly FabricationGenerationNode[],
  technicalByKey: ReadonlyMap<string, ApplicableTechnicalSnapshot>
): string {
  const entries = tree.map((node) => {
    const technical = technicalByKey.get(node.key);
    return {
      key: node.key,
      piece_technique_id: node.piece_technique_id,
      version_id: technical?.version_id ?? null,
      snapshot_sha256: technical?.sha256 ?? null,
      quantite_par_parent: node.quantite_par_parent,
      quantite_cumulee: node.quantite_cumulee,
    };
  });
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export type PurchaseRequirement = {
  of_id: number;
  structure_path: string;
  piece_technique_id: string;
  achat_id: string | null;
  article_id: string | null;
  fournisseur_id: string | null;
  nom: string | null;
  designation: string | null;
  type_achat: string | null;
  qty_per_piece: number;
  qty_required: number;
};

function extractPurchaseRequirements(params: {
  of_id: number;
  structure_path: string;
  piece_technique_id: string;
  qty_lancee: number;
  snapshot: unknown;
}): PurchaseRequirement[] {
  const snapshot = params.snapshot as { achats?: unknown } | null;
  const achats = Array.isArray(snapshot?.achats) ? (snapshot?.achats as Array<Record<string, unknown>>) : [];
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

export type GeneratedOfRef = {
  id: number;
  root_of_id: number;
  parent_of_id: number | null;
  generation_level: number;
  commande_ligne_id: number | null;
};

export type RecursiveOfGenerationResult = {
  batch_id: string;
  root_of_id: number;
  ofs: GeneratedOfRef[];
  source_hash: string;
  purchase_requirements: PurchaseRequirement[];
};

export type OfGenerationSourceType = "COMMANDE_CLIENT" | "AFFAIRE" | "MANUAL";

/**
 * Génère l'arbre complet d'OF (racine + enfants récursifs) dans la transaction
 * fournie : un OF par occurrence fabriquée, opérations copiées depuis la gamme
 * applicable, snapshots technique + structure immuables, batch persistant.
 * Les besoins d'achat sont figés dans le résultat du batch — aucune commande
 * fournisseur n'est émise ici.
 */
export async function createRecursiveOrdresFabrication(tx: Queryable, params: {
  source_type?: OfGenerationSourceType;
  commande_id: number | null;
  commande_numero: string | null;
  commande_ligne_id: number | null;
  livraison_affaire_id: number | null;
  client_id: string | null;
  root_article_id: string | null;
  root_piece_technique_id: string;
  root_pinned_version_id?: string | null;
  qty_to_produce: number;
  user_id: number;
  idempotency_key?: string | null;
  request_hash?: string | null;
}): Promise<RecursiveOfGenerationResult> {
  const sourceType: OfGenerationSourceType = params.source_type ?? "COMMANDE_CLIENT";
  const tree = await loadFabricationGenerationTree(tx, params.root_piece_technique_id);
  if (!tree.length) {
    throw new HttpError(
      422,
      "PIECE_TECHNIQUE_NOT_FOUND",
      `Cannot create OF: piece technique ${params.root_piece_technique_id} was not found`
    );
  }

  // Une seule sélection de version par pièce (déterministe) même quand la même
  // pièce apparaît dans plusieurs branches de l'arbre.
  const technicalByPiece = new Map<string, ApplicableTechnicalSnapshot>();
  const technicalByKey = new Map<string, ApplicableTechnicalSnapshot>();
  for (const node of tree) {
    const pinned = node.level === 0 ? params.root_pinned_version_id ?? null : null;
    const cacheKey = `${node.piece_technique_id}:${pinned ?? ""}`;
    let technical = technicalByPiece.get(cacheKey);
    if (!technical) {
      technical = await loadApplicableTechnicalSnapshot(tx, node.piece_technique_id, { pinned_version_id: pinned });
      technicalByPiece.set(cacheKey, technical);
    }
    technicalByKey.set(node.key, technical);
  }
  const sourceHash = computeOfSourceHash(tree, technicalByKey);

  const ofIdByKey = new Map<string, number>();
  for (const node of tree) {
    ofIdByKey.set(node.key, await allocateOrdreFabricationId(tx));
  }

  const rootOfId = ofIdByKey.get(tree[0].key);
  if (!rootOfId) throw new Error("Failed to allocate root OF id");

  const batchId = crypto.randomUUID();
  await tx.query(
    `
      INSERT INTO public.of_generation_batches (
        id,
        source_type,
        commande_id,
        commande_ligne_id,
        affaire_id,
        root_of_id,
        root_piece_technique_id,
        requested_qty,
        metadata,
        idempotency_key,
        request_hash,
        source_hash,
        created_by
      )
      VALUES ($1::uuid,$2,$3::bigint,$4::bigint,$5::bigint,NULL,$6::uuid,$7,$8::jsonb,$9,$10,$11,$12)
    `,
    [
      batchId,
      sourceType,
      params.commande_id,
      params.commande_ligne_id,
      params.livraison_affaire_id,
      params.root_piece_technique_id,
      params.qty_to_produce,
      JSON.stringify({ commande_numero: params.commande_numero, source_type: sourceType }),
      params.idempotency_key ?? null,
      params.request_hash ?? null,
      sourceHash,
      params.user_id,
    ]
  );

  const generatedOfs: GeneratedOfRef[] = [];
  const purchaseRequirements: PurchaseRequirement[] = [];

  for (const node of tree) {
    const ofId = ofIdByKey.get(node.key);
    if (!ofId) throw new Error(`Missing OF id for fabrication node ${node.key}`);

    const parentOfId = node.parent_key ? ofIdByKey.get(node.parent_key) ?? null : null;
    if (node.parent_key && !parentOfId) {
      throw new Error(`Missing parent OF id for fabrication node ${node.key}`);
    }

    const technical = technicalByKey.get(node.key);
    if (!technical) throw new Error(`Missing technical snapshot for fabrication node ${node.key}`);
    const numero = await generateTransactionalBusinessCode(tx, { prefix: "OF" });
    const qtyLancee = Number((params.qty_to_produce * node.quantite_cumulee).toFixed(3));
    const articleId = node.article_id ?? (node.level === 0 ? params.root_article_id : null);
    const notePrefix = node.level === 0 ? "piece mere" : "sous-piece";
    const noteSource =
      sourceType === "COMMANDE_CLIENT" && params.commande_numero
        ? `Generated from commande ${params.commande_numero} line ${params.commande_ligne_id ?? "?"}`
        : sourceType === "AFFAIRE"
          ? `Generated from affaire ${params.livraison_affaire_id ?? "?"}`
          : "Generated manually";

    await tx.query(
      `
        INSERT INTO public.ordres_fabrication (
          id,
          numero,
          affaire_id,
          commande_id,
          commande_ligne_id,
          article_id,
          client_id,
          piece_technique_id,
          piece_technique_version_id,
          technical_snapshot,
          technical_snapshot_sha256,
          technical_snapshot_at,
          parent_of_id,
          root_of_id,
          generation_batch_id,
          generation_level,
          source_bom_line_id,
          structure_path,
          quantity_per_parent,
          quantity_cumulative,
          quantite_lancee,
          statut,
          priority,
          notes,
          created_by,
          updated_by
        ) VALUES (
          $1,$2,$3::bigint,$4::bigint,$5::bigint,$6::uuid,$7,$8::uuid,
          $9::uuid,$10::jsonb,$11,now(),
          $12::bigint,$13::bigint,$14::uuid,$15,$16::uuid,$17,$18,$19,
          $20,'BROUILLON'::of_status,'NORMAL'::of_priority,$21,$22,$22
        )
      `,
      [
        ofId,
        numero,
        params.livraison_affaire_id,
        params.commande_id,
        params.commande_ligne_id,
        articleId,
        params.client_id,
        node.piece_technique_id,
        technical.version_id,
        JSON.stringify(technical.snapshot),
        technical.sha256,
        parentOfId,
        rootOfId,
        batchId,
        node.level,
        node.bom_line_id,
        node.key,
        node.quantite_par_parent,
        node.quantite_cumulee,
        qtyLancee,
        `${noteSource} (${notePrefix} ${node.code_piece})`,
        params.user_id,
      ]
    );

    const operationsCount = await copyPieceOperationsToOf(tx, {
      of_id: ofId,
      piece_technique_id: node.piece_technique_id,
      gamme_id: technical.gamme_id,
    });
    if (operationsCount === 0) {
      throw new HttpError(
        409,
        "PIECE_TECHNIQUE_OPERATION_REQUIRED",
        `Cannot create complete OF: piece technique ${node.code_piece} has no operation for line ${params.commande_ligne_id ?? "?"}`
      );
    }

    await tx.query(
      `
        INSERT INTO public.of_technical_snapshots (
          of_id, piece_technique_version_id, snapshot, snapshot_sha256, created_by
        ) VALUES ($1::bigint, $2::uuid, $3::jsonb, $4, $5)
      `,
      [ofId, technical.version_id, JSON.stringify(technical.snapshot), technical.sha256, params.user_id]
    );

    await tx.query(
      `
        INSERT INTO public.of_structure_snapshot (
          generation_batch_id,
          root_of_id,
          parent_of_id,
          of_id,
          level,
          structure_path,
          source_bom_line_id,
          parent_piece_technique_id,
          piece_technique_id,
          piece_code,
          piece_designation,
          piece_version_number,
          quantite_par_parent,
          quantite_cumulee,
          quantite_lancee
        )
        VALUES (
          $1::uuid,$2::bigint,$3::bigint,$4::bigint,$5,$6,$7::uuid,$8::uuid,
          $9::uuid,$10,$11,$12,$13,$14,$15
        )
      `,
      [
        batchId,
        rootOfId,
        parentOfId,
        ofId,
        node.level,
        node.key,
        node.bom_line_id,
        node.parent_piece_technique_id,
        node.piece_technique_id,
        node.code_piece,
        node.designation,
        technical.version_interne ?? node.version_number,
        node.quantite_par_parent,
        node.quantite_cumulee,
        qtyLancee,
      ]
    );

    purchaseRequirements.push(
      ...extractPurchaseRequirements({
        of_id: ofId,
        structure_path: node.key,
        piece_technique_id: node.piece_technique_id,
        qty_lancee: qtyLancee,
        snapshot: technical.snapshot,
      })
    );

    generatedOfs.push({
      id: ofId,
      root_of_id: rootOfId,
      parent_of_id: parentOfId,
      generation_level: node.level,
      commande_ligne_id: params.commande_ligne_id,
    });
  }

  await tx.query(
    `UPDATE public.of_generation_batches SET root_of_id = $2::bigint WHERE id = $1::uuid`,
    [batchId, rootOfId]
  );

  await tx.query(
    `UPDATE public.of_generation_batches SET result = $2::jsonb WHERE id = $1::uuid`,
    [
      batchId,
      JSON.stringify({
        root_of_id: rootOfId,
        of_ids: generatedOfs.map((of) => of.id),
        root_of_ids: generatedOfs.filter((of) => of.parent_of_id === null).map((of) => of.id),
        child_of_ids: generatedOfs.filter((of) => of.parent_of_id !== null).map((of) => of.id),
        total_nodes: generatedOfs.length,
        max_level: generatedOfs.reduce((acc, of) => Math.max(acc, of.generation_level), 0),
        source_hash: sourceHash,
        purchase_requirements: purchaseRequirements,
      }),
    ]
  );

  return {
    batch_id: batchId,
    root_of_id: rootOfId,
    ofs: generatedOfs,
    source_hash: sourceHash,
    purchase_requirements: purchaseRequirements,
  };
}
