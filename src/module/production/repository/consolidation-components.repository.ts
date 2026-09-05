import type { PoolClient } from "pg";
import { createRecursiveOrdresFabrication } from "../domain/of-generation";
import type { AuditContext } from "./production.repository";
import { preparationAudit } from "./production-preparation.repository";
type Db = Pick<PoolClient, "query">;
type Bom = {
  id: string;
  child_piece_technique_id: string | null;
  child_piece_technique_version_id: string | null;
  child_article_id: string | null;
  quantite: number;
};
type Snapshot = { nomenclature?: Bom[] };

/** Additional stock is a real assembly demand: explicitly generate its
 * components too. Existing source reservations are transferred separately. */
export async function createConsolidationSurplusComponents(
  tx: Db,
  input: {
    group_id: string;
    producer_id: number;
    piece_id: string;
    version_id: string;
    client_id: string | null;
    surplus: number;
    snapshot: unknown;
  },
  audit: AuditContext,
) {
  if (input.surplus <= 0) return [];
  const created: number[] = [];
  const addRequirement = async (
    parent: number,
    piece: string,
    version: string,
    bom: Bom,
    quantity: number,
    childId: number | null,
  ) => {
    const child = childId
      ? (
          await tx.query<{
            article_id: string | null;
            version_id: string | null;
          }>(
            "SELECT article_id::text,technical_preparation->>'selected_version_id' AS version_id FROM public.ordres_fabrication WHERE id=$1",
            [childId],
          )
        ).rows[0]
      : null;
    await tx.query(
      `INSERT INTO public.of_component_requirements(consuming_of_id,component_of_id,parent_piece_technique_id,parent_piece_technique_version_id,component_kind,
      component_article_id,component_piece_technique_id,component_piece_technique_version_id,structure_path,quantity_per_parent,required_qty,shortage_qty,action,created_by,purchase_requirement)
      VALUES($1,$2,$3::uuid,$4::uuid,$5,$6::uuid,$7::uuid,$8::uuid,$9,$10,$11,$11,$12,$13,
        CASE WHEN $5='PURCHASED' THEN jsonb_build_object('article_id',$6::uuid,'quantity',$11::numeric) END)`,
      [
        parent,
        childId,
        piece,
        version,
        bom.child_piece_technique_id ? "FABRICATED" : "PURCHASED",
        bom.child_article_id ?? child?.article_id,
        bom.child_piece_technique_id,
        bom.child_piece_technique_version_id ?? child?.version_id,
        `consolidation/${input.group_id}/${parent}/${bom.id}`,
        bom.quantite,
        quantity,
        childId
          ? (bom.child_article_id ?? child?.article_id)
            ? "CREATE_CHILD_OF"
            : "WAIT_TECHNICAL"
          : "PURCHASE",
        audit.user_id,
      ],
    );
  };
  for (const bom of (input.snapshot as Snapshot).nomenclature ?? []) {
    const required =
      Math.round(input.surplus * Number(bom.quantite) * 1000) / 1000;
    let childId: number | null = null;
    if (bom.child_piece_technique_id) {
      const generated = await createRecursiveOrdresFabrication(tx, {
        source_type: "MANUAL",
        commande_id: null,
        commande_numero: null,
        commande_ligne_id: null,
        livraison_affaire_id: null,
        client_id: input.client_id,
        root_article_id: bom.child_article_id,
        root_piece_technique_id: bom.child_piece_technique_id,
        root_pinned_version_id: bom.child_piece_technique_version_id,
        qty_to_produce: required,
        user_id: audit.user_id,
        force_preparation: true,
      });
      childId = generated.root_of_id;
      created.push(...generated.ofs.map((o) => o.id));
      // The generation snapshot retains the original generation event. The
      // current parent relationship records the actual consuming producer.
      await tx.query(
        `UPDATE public.ordres_fabrication SET parent_of_id=CASE WHEN id=$2 THEN $3::bigint ELSE parent_of_id END,root_of_id=$3,generation_level=generation_level+1,
        technical_preparation=technical_preparation||jsonb_build_object('consolidation_surplus_id',$4::text),updated_at=now(),updated_by=$5 WHERE id=ANY($1::bigint[])`,
        [
          generated.ofs.map((o) => o.id),
          childId,
          input.producer_id,
          input.group_id,
          audit.user_id,
        ],
      );
      const nodes = (
        await tx.query<{
          id: number;
          piece_technique_id: string;
          version_id: string;
          quantite_lancee: number;
          parent_of_id: number | null;
          source_bom_line_id: string | null;
        }>(
          `SELECT id::bigint::int,piece_technique_id::text,technical_preparation->>'selected_version_id' AS version_id,quantite_lancee::float8,parent_of_id::bigint::int,source_bom_line_id::text FROM public.ordres_fabrication WHERE id=ANY($1::bigint[])`,
          [generated.ofs.map((o) => o.id)],
        )
      ).rows;
      for (const node of nodes) {
        await preparationAudit(
          tx,
          audit,
          node.id,
          "production.consolidation.surplus.component.create",
          {
            consolidation_id: input.group_id,
            producer_of_id: input.producer_id,
            quantity: node.quantite_lancee,
          },
        );
      }
    }
    await addRequirement(
      input.producer_id,
      input.piece_id,
      input.version_id,
      bom,
      required,
      childId,
    );
  }
  await tx.query(
    `UPDATE public.production_consolidations SET surplus_of_ids=$2::bigint[] WHERE id=$1::uuid`,
    [input.group_id, created],
  );
  return created;
}
