import type { PoolClient } from "pg";

export type DuplicateCommandeLine = {
  designation: string; code_piece: string | null; article_id: string | null;
  piece_technique_id: string | null; source_article_devis_id: string | null;
  source_dossier_devis_id: string | null; quantite: number | string;
  unite: string | null; prix_unitaire_ht: number | string;
  remise_ligne: number | string | null; taux_tva: number | string | null;
  delai_client: string | null; delai_interne: string | null;
  devis_numero: string | null; famille: string | null;
};

/** Civil due dates must survive duplication without passing through a JS instant. */
export async function readCommandeDuplicateLinesTx(
  tx: Pick<PoolClient, "query">,
  commandeId: number,
): Promise<DuplicateCommandeLine[]> {
  const result = await tx.query<DuplicateCommandeLine>(
    `SELECT designation, code_piece, article_id::text AS article_id,
            piece_technique_id::text AS piece_technique_id,
            source_article_devis_id::text AS source_article_devis_id,
            source_dossier_devis_id::text AS source_dossier_devis_id,
            quantite, unite, prix_unitaire_ht, remise_ligne, taux_tva,
            to_char(delai_client, 'YYYY-MM-DD') AS delai_client,
            to_char(delai_interne, 'YYYY-MM-DD') AS delai_interne,
            devis_numero, famille
       FROM public.commande_ligne WHERE commande_id = $1 ORDER BY id ASC`,
    [commandeId],
  );
  return result.rows;
}
