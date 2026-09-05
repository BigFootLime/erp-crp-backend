import { randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { generateTransactionalBusinessCode } from "../../../shared/codes/code-generator.service";
import { synchronizeDraftChildrenTx } from "../repository/preparation-children.repository";
import type {
  RecursiveOfGenerationResult,
  OfGenerationSourceType,
  GeneratedOfRef,
} from "./of-generation";

type Db = Pick<PoolClient, "query">;
type Input = {
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
};
/** Materialize the selected draft BOM without inventing a validated snapshot or
 * operations. The version-specific reconciliation is also used during review. */
export async function createPreparationDraftTree(
  tx: Db,
  p: Input,
): Promise<RecursiveOfGenerationResult> {
  if (p.idempotency_key) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      p.idempotency_key,
    ]);
    const replay = (
      await tx.query<{
        request_hash: string | null;
        result: RecursiveOfGenerationResult;
      }>(
        "SELECT request_hash,result FROM public.of_generation_batches WHERE idempotency_key=$1",
        [p.idempotency_key],
      )
    ).rows[0];
    if (replay) {
      if (replay.request_hash !== p.request_hash)
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Cette clé correspond à une autre génération.",
        );
      return replay.result;
    }
  }
  const piece = (
    await tx.query<{ article_id: string | null; version_id: string | null }>(
      `SELECT p.article_id::text,(SELECT v.id::text FROM public.piece_technique_versions v WHERE v.piece_technique_id=p.id AND v.statut<>'OBSOLETE' AND ($2::uuid IS NULL OR v.id=$2::uuid) ORDER BY v.is_current DESC,v.created_at DESC,v.id LIMIT 1) AS version_id FROM public.pieces_techniques p WHERE p.id=$1::uuid AND p.deleted_at IS NULL`,
      [p.root_piece_technique_id, p.root_pinned_version_id ?? null],
    )
  ).rows[0];
  if (!piece)
    throw new HttpError(
      404,
      "PIECE_TECHNIQUE_NOT_FOUND",
      "Pièce technique introuvable.",
    );
  if (p.root_pinned_version_id && !piece.version_id)
    throw new HttpError(
      422,
      "OF_VERSION_CONFLICT",
      "L’indice demandé ne correspond pas à une révision utilisable de la pièce.",
    );
  const id = Number(
    (
      await tx.query(
        "SELECT nextval(pg_get_serial_sequence('public.ordres_fabrication','id')) AS id",
      )
    ).rows[0].id,
  );
  const batch = randomUUID(),
    numero = await generateTransactionalBusinessCode(tx, { prefix: "OF" });
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        piece: p.root_piece_technique_id,
        version: piece.version_id,
        quantity: p.qty_to_produce,
        readiness: "INCOMPLETE",
      }),
    )
    .digest("hex");
  await tx.query(
    `INSERT INTO public.of_generation_batches(id,source_type,commande_id,commande_ligne_id,affaire_id,root_piece_technique_id,requested_qty,source_hash,created_by,idempotency_key,request_hash,metadata)
    VALUES($1::uuid,$2,$3,$4,$5,$6::uuid,$7,$8,$9,$10,$11,jsonb_build_object('preparation_rules_version',1))`,
    [
      batch,
      p.source_type ?? "COMMANDE_CLIENT",
      p.commande_id,
      p.commande_ligne_id,
      p.livraison_affaire_id,
      p.root_piece_technique_id,
      p.qty_to_produce,
      hash,
      p.user_id,
      p.idempotency_key ?? null,
      p.request_hash ?? null,
    ],
  );
  await tx.query(
    `INSERT INTO public.ordres_fabrication(id,numero,client_id,article_id,piece_technique_id,commande_id,commande_ligne_id,affaire_id,root_of_id,generation_batch_id,generation_level,structure_path,quantity_per_parent,quantity_cumulative,quantite_lancee,statut,technical_preparation,preparation_rules_version,created_by,updated_by)
    VALUES($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$1,$9::uuid,0,$10,1,1,$11,'BROUILLON',jsonb_build_object('selected_version_id',$12::text),1,$13,$13)`,
    [
      id,
      numero,
      p.client_id,
      p.root_article_id ?? piece.article_id,
      p.root_piece_technique_id,
      p.commande_id,
      p.commande_ligne_id,
      p.livraison_affaire_id,
      batch,
      String(id),
      p.qty_to_produce,
      piece.version_id,
      p.user_id,
    ],
  );
  await synchronizeDraftChildrenTx(tx, id, p.user_id);
  await tx.query(
    "UPDATE public.ordres_fabrication SET generation_batch_id=$2::uuid WHERE root_of_id=$1 AND generation_batch_id IS NULL",
    [id, batch],
  );
  const ofs = (
    await tx.query<GeneratedOfRef>(
      `SELECT id::bigint::int,root_of_id::bigint::int,parent_of_id::bigint::int,generation_level,commande_ligne_id::bigint::int,0 AS operations_count,technical_readiness,structure_path FROM public.ordres_fabrication WHERE root_of_id=$1 AND statut<>'ANNULE' ORDER BY generation_level,id`,
      [id],
    )
  ).rows;
  const result: RecursiveOfGenerationResult = {
    batch_id: batch,
    root_of_id: id,
    ofs,
    source_hash: hash,
    purchase_requirements: [],
    warnings: [],
  };
  await tx.query(
    "UPDATE public.of_generation_batches SET root_of_id=$2,result=$3::jsonb WHERE id=$1::uuid",
    [
      batch,
      id,
      JSON.stringify({
        ...result,
        of_ids: ofs.map((o) => o.id),
        technical_readiness: "INCOMPLETE",
      }),
    ],
  );
  return result;
}
