import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { generateTransactionalBusinessCode } from "../../../shared/codes/code-generator.service";
type Db = Pick<PoolClient, "query">;
type Order = {
  id: number;
  piece_technique_id: string;
  version_id: string | null;
  client_id: string | null;
  commande_id: number | null;
  commande_ligne_id: number | null;
  affaire_id: number | null;
  root_of_id: number;
  generation_level: number;
  quantity_cumulative: number;
  quantite_lancee: number;
  statut: string;
  technical_snapshot_sha256: string | null;
};
type Line = {
  id: string;
  child_piece_technique_id: string | null;
  child_piece_technique_version_id: string | null;
  child_article_id: string | null;
  quantite: number;
  rang: number;
};

/** Reconcile by parent and BOM occurrence. Unchanged prepared children retain
 * their evidence; no engaged child, reservation or receipt is overwritten. */
export async function synchronizeDraftChildrenTx(
  tx: Db,
  id: number,
  userId: number,
) {
  const affected: number[] = [];
  const walk = async (ofId: number, ancestors: string[]): Promise<void> => {
    const o = (
      await tx.query<Order>(
        `SELECT id::bigint::int,piece_technique_id::text,COALESCE(piece_technique_version_id,NULLIF(technical_preparation->>'selected_version_id','')::uuid,NULLIF(technical_preparation->>'selected_draft_version_id','')::uuid)::text AS version_id,
      client_id,commande_id::bigint::int,commande_ligne_id::bigint::int,affaire_id::bigint::int,COALESCE(root_of_id,id)::bigint::int AS root_of_id,generation_level,quantity_cumulative::float8,quantite_lancee::float8,statut::text,technical_snapshot_sha256
      FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE`,
        [ofId],
      )
    ).rows[0];
    if (!o) throw new HttpError(404, "OF_NOT_FOUND", "OF introuvable.");
    if (ancestors.includes(o.piece_technique_id) || ancestors.length >= 50)
      throw new HttpError(
        422,
        "BOM_CYCLE_DETECTED",
        "La structure contient un cycle ou dépasse 50 niveaux.",
      );
    if (!o.version_id) return;
    if (o.technical_snapshot_sha256) return;
    if (o.statut !== "BROUILLON")
      throw new HttpError(409, "CHILD_OF_ENGAGED", "Un OF est déjà engagé.");
    await tx.query(
      "SELECT id FROM public.piece_technique_versions WHERE id=$1::uuid FOR SHARE",
      [o.version_id],
    );
    const policy = (
      await tx.query<{ assembly_supply_strategy: string }>(
        "SELECT assembly_supply_strategy FROM public.piece_technique_versions WHERE id=$1::uuid",
        [o.version_id],
      )
    ).rows[0];
    if (policy?.assembly_supply_strategy === "INTERNAL_CONTRACT") return;
    const lines = (
      await tx.query<Line>(
        `SELECT id::text,child_piece_technique_id::text,child_piece_technique_version_id::text,child_article_id::text,quantite::float8,rang FROM public.pieces_techniques_nomenclature WHERE parent_piece_technique_version_id=$1::uuid ORDER BY rang,id`,
        [o.version_id],
      )
    ).rows;
    const retained: number[] = [];
    const requirements: string[] = [];
    for (const line of lines) {
      const qty = Math.round(o.quantite_lancee * line.quantite * 1000) / 1000;
      if (qty <= 0)
        throw new HttpError(
          422,
          "COMPONENT_QUANTITY_TOO_SMALL",
          "Une quantité de composant est inférieure à la précision de fabrication.",
        );
      let childId: number | null = null;
      let childVersion = line.child_piece_technique_version_id;
      let article = line.child_article_id;
      if (line.child_piece_technique_id) {
        const piece = (
          await tx.query<{
            article_id: string | null;
            version_id: string | null;
          }>(
            `SELECT p.article_id::text,(SELECT v.id::text FROM public.piece_technique_versions v WHERE v.piece_technique_id=p.id AND v.statut<>'OBSOLETE' AND ($2::uuid IS NULL OR v.id=$2::uuid) ORDER BY v.is_current DESC,v.created_at DESC,v.id LIMIT 1) AS version_id FROM public.pieces_techniques p WHERE p.id=$1::uuid AND p.deleted_at IS NULL`,
            [line.child_piece_technique_id, childVersion],
          )
        ).rows[0];
        if (!piece)
          throw new HttpError(
            422,
            "COMPONENT_MISSING",
            "Une sous-pièce n’est plus disponible.",
          );
        childVersion = piece.version_id;
        article = article ?? piece.article_id;
        const external = (
          await tx.query<{ quantity: number }>(
            `SELECT COALESCE(sum(sr.qty_reserved),0)::float8 AS quantity FROM public.of_component_requirements r
          JOIN public.stock_reservations sr ON sr.of_component_requirement_id=r.id AND sr.status IN ('ACTIVE','CONSUMED')
          WHERE r.consuming_of_id=$1 AND r.status<>'CANCELLED'
            AND (r.structure_path=$2 OR r.component_of_id IN(SELECT id FROM public.ordres_fabrication WHERE parent_of_id=$1 AND source_bom_line_id=$3::uuid))
            AND NOT EXISTS(SELECT 1 FROM public.of_receipts receipt WHERE receipt.of_id=r.component_of_id AND receipt.lot_id=sr.lot_id)`,
            [ofId, `workbench/${ofId}/${line.id}`, line.id],
          )
        ).rows[0];
        const manufactureQty = Math.max(
          0,
          Math.round((qty - (external?.quantity ?? 0)) * 1000) / 1000,
        );
        if (manufactureQty > 0) {
          const existing = (
            await tx.query<{
              id: number;
              version_id: string | null;
              quantite_lancee: number;
              statut: string;
              technical_snapshot_sha256: string | null;
            }>(
              `SELECT id::bigint::int,COALESCE(piece_technique_version_id,NULLIF(technical_preparation->>'selected_version_id','')::uuid)::text AS version_id,quantite_lancee::float8,statut::text,technical_snapshot_sha256 FROM public.ordres_fabrication WHERE parent_of_id=$1 AND source_bom_line_id=$2::uuid AND statut<>'ANNULE' ORDER BY id FOR UPDATE`,
              [ofId, line.id],
            )
          ).rows;
          if (existing.length > 1)
            throw new HttpError(
              409,
              "COMPONENT_DUPLICATE_OF",
              "Plusieurs sous-OF couvrent la même ligne. Vérifiez leur affectation.",
            );
          const child = existing[0];
          if (child) {
            childId = child.id;
            if (
              child.version_id !== childVersion ||
              Math.abs(child.quantite_lancee - manufactureQty) > 0.000001
            ) {
              if (
                child.statut !== "BROUILLON" ||
                child.technical_snapshot_sha256
              )
                throw new HttpError(
                  409,
                  "CHILD_OF_ENGAGED",
                  "Une modification touche un sous-OF déjà préparé. Révisez ce sous-OF avant de synchroniser.",
                );
              if (
                (
                  await tx.query(
                    `SELECT 1 FROM public.stock_reservations WHERE of_id=$1 AND status IN ('ACTIVE','CONSUMED') LIMIT 1`,
                    [child.id],
                  )
                ).rows[0]
              )
                throw new HttpError(
                  409,
                  "CHILD_STOCK_RESERVED",
                  "Un sous-OF possède des réservations à réviser.",
                );
              await tx.query(
                `UPDATE public.ordres_fabrication SET quantite_lancee=$2,technical_preparation=technical_preparation||jsonb_build_object('selected_version_id',$3::text),technical_readiness='INCOMPLETE',technical_submitted_at=NULL,technical_submitted_by=NULL,updated_at=now(),updated_by=$4 WHERE id=$1`,
                [child.id, manufactureQty, childVersion, userId],
              );
              affected.push(child.id);
            }
          } else {
            childId = Number(
              (
                await tx.query(
                  `SELECT nextval(pg_get_serial_sequence('public.ordres_fabrication','id')) AS id`,
                )
              ).rows[0].id,
            );
            const numero = await generateTransactionalBusinessCode(tx, {
              prefix: "OF",
            });
            await tx.query(
              `INSERT INTO public.ordres_fabrication(id,numero,client_id,article_id,piece_technique_id,commande_id,commande_ligne_id,affaire_id,parent_of_id,root_of_id,generation_level,source_bom_line_id,structure_path,quantity_per_parent,quantity_cumulative,quantite_lancee,statut,technical_preparation,preparation_rules_version,created_by,updated_by)
            VALUES($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11,$12::uuid,$13,$14,$18,$15,'BROUILLON',jsonb_build_object('selected_version_id',$16::text),1,$17,$17)`,
              [
                childId,
                numero,
                o.client_id,
                article,
                line.child_piece_technique_id,
                o.commande_id,
                o.commande_ligne_id,
                o.affaire_id,
                ofId,
                o.root_of_id,
                o.generation_level + 1,
                line.id,
                `workbench/${ofId}/${line.id}`,
                line.quantite,
                manufactureQty,
                childVersion,
                userId,
                line.quantite * o.quantity_cumulative,
              ],
            );
            affected.push(childId);
          }
          retained.push(childId);
          await walk(childId, [...ancestors, o.piece_technique_id]);
        }
      }
      const prior = (
        await tx.query<{ id: string; required_qty: number }>(
          `SELECT id::text,required_qty::float8 FROM public.of_component_requirements WHERE consuming_of_id=$1 AND status<>'CANCELLED' AND (structure_path=$2 OR ($3::bigint IS NOT NULL AND component_of_id=$3) OR component_of_id IN(SELECT id FROM public.ordres_fabrication WHERE parent_of_id=$1 AND source_bom_line_id=$4::uuid)) ORDER BY id FOR UPDATE`,
          [ofId, `workbench/${ofId}/${line.id}`, childId, line.id],
        )
      ).rows;
      if (prior.length > 1)
        throw new HttpError(
          409,
          "COMPONENT_DUPLICATE_REQUIREMENT",
          "Le composant possède plusieurs besoins actifs.",
        );
      if (prior[0]) {
        requirements.push(prior[0].id);
        if (Math.abs(prior[0].required_qty - qty) > 0.000001) {
          if (
            (
              await tx.query(
                `SELECT 1 FROM public.stock_reservations WHERE of_component_requirement_id=$1::uuid AND status IN ('ACTIVE','CONSUMED') LIMIT 1`,
                [prior[0].id],
              )
            ).rows[0]
          )
            throw new HttpError(
              409,
              "COMPONENT_STOCK_RESERVED",
              "La quantité d’un composant réservé doit être révisée.",
            );
          await tx.query(
            `UPDATE public.of_component_requirements SET required_qty=$2,shortage_qty=$2,old_reserved_qty=0,new_reserved_qty=0,status='OPEN',updated_at=now() WHERE id=$1::uuid`,
            [prior[0].id, qty],
          );
        }
      } else {
        const req = (
          await tx.query<{ id: string }>(
            `INSERT INTO public.of_component_requirements(consuming_of_id,component_of_id,parent_piece_technique_id,parent_piece_technique_version_id,component_kind,component_article_id,component_piece_technique_id,component_piece_technique_version_id,structure_path,quantity_per_parent,required_qty,shortage_qty,action,created_by)
          VALUES($1,$2,$3::uuid,$4::uuid,$5,$6::uuid,$7::uuid,$8::uuid,$9,$10,$11,$11,$12,$13) RETURNING id::text`,
            [
              ofId,
              childId,
              o.piece_technique_id,
              o.version_id,
              line.child_piece_technique_id ? "FABRICATED" : "PURCHASED",
              article,
              line.child_piece_technique_id,
              childVersion,
              `workbench/${ofId}/${line.id}`,
              line.quantite,
              qty,
              childId
                ? article
                  ? "CREATE_CHILD_OF"
                  : "WAIT_TECHNICAL"
                : "PURCHASE",
              userId,
            ],
          )
        ).rows[0];
        requirements.push(req.id);
      }
    }
    const obsolete = (
      await tx.query<{
        id: number;
        statut: string;
        technical_snapshot_sha256: string | null;
      }>(
        `WITH RECURSIVE removed AS(SELECT id FROM public.ordres_fabrication WHERE parent_of_id=$1 AND statut<>'ANNULE' AND NOT(id=ANY($2::bigint[])) UNION ALL SELECT o.id FROM public.ordres_fabrication o JOIN removed r ON o.parent_of_id=r.id WHERE o.statut<>'ANNULE') SELECT o.id::bigint::int,o.statut::text,o.technical_snapshot_sha256 FROM public.ordres_fabrication o JOIN removed r ON r.id=o.id ORDER BY o.id FOR UPDATE OF o`,
        [ofId, retained],
      )
    ).rows;
    if (
      obsolete.some(
        (c) => c.statut !== "BROUILLON" || c.technical_snapshot_sha256,
      )
    )
      throw new HttpError(
        409,
        "CHILD_OF_ENGAGED",
        "Une sous-pièce retirée a déjà été préparée.",
      );
    const obsoleteIds = obsolete.map((c) => c.id);
    if (
      (
        await tx.query(
          `SELECT 1 FROM public.stock_reservations WHERE status IN ('ACTIVE','CONSUMED') AND (of_id=ANY($1::bigint[]) OR of_component_requirement_id IN(SELECT id FROM public.of_component_requirements WHERE consuming_of_id=$2 AND NOT(id=ANY($3::uuid[])))) LIMIT 1`,
          [obsoleteIds, ofId, requirements],
        )
      ).rows[0]
    )
      throw new HttpError(
        409,
        "COMPONENT_STOCK_RESERVED",
        "Un composant retiré possède une réservation.",
      );
    await tx.query(
      `UPDATE public.of_component_requirements SET status='CANCELLED',updated_at=now() WHERE consuming_of_id=ANY($1::bigint[]) OR (consuming_of_id=$2 AND NOT(id=ANY($3::uuid[])))`,
      [obsoleteIds, ofId, requirements],
    );
    await tx.query(
      `UPDATE public.ordres_fabrication SET statut='ANNULE',updated_at=now(),updated_by=$2 WHERE id=ANY($1::bigint[])`,
      [obsoleteIds, userId],
    );
    affected.push(...obsoleteIds);
  };
  await walk(id, []);
  return [...new Set(affected)];
}
