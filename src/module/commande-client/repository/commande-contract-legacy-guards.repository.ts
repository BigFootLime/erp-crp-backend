import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type { CreateCommandeInput } from "../types/commande-client.types";

type Queryer = Pick<PoolClient, "query">;
const normalized = (value: string | null | undefined) => value?.toLowerCase() ?? null;

export async function assertLegacyContractOrderMutable(db: Queryer, id: string, input: CreateCommandeInput) {
  const association = (await db.query<{ client_id: string }>(
    "SELECT client_id FROM public.client_contract_legacy_orders WHERE commande_id=$1::bigint", [id])).rows[0];
  if (!association) return;
  if (input.client_id !== association.client_id || (input.order_type !== undefined && input.order_type !== "CADRE")) {
    throw new HttpError(409, "LEGACY_CONTRACT_ORDER_IDENTITY_IMMUTABLE", "Le cadre associé conserve son client et sa définition historique");
  }
  const { rows } = await db.query<{ commande_ligne_id: string; article_id: string; piece_technique_id: string | null;
    piece_technique_version_id: string | null; unit: string }>(`
    SELECT binding.commande_ligne_id::text,binding.article_id::text,
      binding.historical_line->>'piece_technique_id' AS piece_technique_id,
      binding.piece_technique_version_id::text,binding.historical_line->>'unit' AS unit
    FROM public.client_contract_legacy_lines binding
    JOIN public.client_contract_legacy_orders legacy ON legacy.id=binding.legacy_order_id
    WHERE legacy.commande_id=$1::bigint ORDER BY binding.commande_ligne_id`, [id]);
  if (rows.length !== input.lignes.length || rows.some(row => !input.lignes.some(line => String(line.id) === row.commande_ligne_id
    && normalized(line.article_id) === row.article_id
    && normalized(line.piece_technique_id) === row.piece_technique_id
    && normalized(line.piece_technique_version_id) === row.piece_technique_version_id
    && normalized(line.unite) === normalized(row.unit)))) {
    throw new HttpError(409, "LEGACY_CONTRACT_LINES_IMMUTABLE", "Les lignes, articles, indices et unités historiques sont conservés. Créez un nouvel appel depuis le contrat.");
  }
}

export async function assertNoLegacyContractAssociation(db: Queryer, id: number) {
  if ((await db.query("SELECT 1 FROM public.client_contract_legacy_orders WHERE commande_id=$1::bigint", [id])).rows.length) {
    throw new HttpError(409, "LEGACY_CONTRACT_HISTORY_RETAINED", "Ce cadre associé est conservé dans l’historique du contrat");
  }
}

export async function assertLegacyReleaseCompositionEditable(db: Queryer, id: number) {
  if ((await db.query("SELECT 1 FROM public.client_contract_legacy_orders WHERE commande_id=$1::bigint", [id])).rows.length) {
    throw new HttpError(409, "LEGACY_CONTRACT_RELEASE_HISTORY_RETAINED", "Créez les nouvelles demandes depuis le contrat de la fiche client. Les anciens appels sont conservés.");
  }
}
