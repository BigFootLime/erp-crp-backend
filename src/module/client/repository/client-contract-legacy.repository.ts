import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { LegacyContractSourceLine, LegacyContractMapping } from "../domain/client-contract-legacy";
import type { ClientContract } from "../types/client-contract.types";

type Queryer = Pick<PoolClient, "query">;
export type LegacyOrderSnapshot = {
  id: string;
  numero: string;
  client_id: string;
  customer_reference: string | null;
  order_date: string | null;
  order_type: string;
  lines: LegacyContractSourceLine[];
  releases: unknown[];
};
export type LegacyContractAssociation = {
  id: string;
  contract_id: string;
  commande_id: string;
  contract_version: number;
  reference: string;
  reason: string;
  actor_user_id: number;
  created_at: string;
};

// Units are resolved only when their canonical code has one exact case-insensitive
// match. A technical version stays the ordered one; there is no current-PT fallback.
export const LEGACY_ORDER_SNAPSHOT_SQL = `
SELECT jsonb_build_object('id',command.id::text,'numero',command.numero,'client_id',command.client_id,
  'customer_reference',command.code_client,'order_date',command.date_commande::text,'order_type',command.order_type,
  'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',line.id::text,'article_id',line.article_id::text,'root_article_id',COALESCE(article.root_article_id,article.id)::text,
    'piece_technique_id',line.piece_technique_id::text,'piece_technique_version_id',line.piece_technique_version_id::text,'indice',technical.indice,
    'unit_id',unit.id,'unit',line.unite,'code',COALESCE(article.code,line.code_piece),
    'designation',line.designation,'quantity',line.quantite::text,'due_date',line.delai_client::text,
    'technical_identity_valid',(line.piece_technique_id IS NULL OR COALESCE(line.piece_technique_id=article.piece_technique_id,false))
      AND (line.piece_technique_version_id IS NULL OR COALESCE(technical.piece_technique_id=article.piece_technique_id,false))) ORDER BY line.id)
    FROM public.commande_ligne line LEFT JOIN public.articles article ON article.id=line.article_id
    LEFT JOIN public.piece_technique_versions technical ON technical.id=line.piece_technique_version_id
    LEFT JOIN LATERAL (SELECT CASE WHEN count(*)=1 THEN min(id::text) END AS id FROM public.units
      WHERE lower(code)=lower(line.unite)) unit ON true
    WHERE line.commande_id=command.id),'[]'::jsonb),
  'releases',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',release.id::text,'number',release.numero_release,
    'request_date',release.date_demande::text,'due_date',release.date_livraison_prevue::text,'status',release.statut,
    'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',item.id::text,'source_line_id',item.commande_ligne_id::text,
      'article_id',item.article_id::text,'quantity',item.quantite::text,'unit',item.unite,'due_date',item.delai_client::text)
      ORDER BY item.id) FROM public.commande_cadre_release_ligne item WHERE item.release_id=release.id),'[]'::jsonb))
    ORDER BY release.id) FROM public.commande_cadre_release release WHERE release.commande_cadre_id=command.id),'[]'::jsonb)) AS snapshot
FROM public.commande_client command WHERE command.id=$1::bigint AND command.client_id=$2
`;

export async function readLegacyOrderSnapshot(db: Queryer, clientId: string, id: string) {
  const row = (await db.query<{ snapshot: LegacyOrderSnapshot }>(LEGACY_ORDER_SNAPSHOT_SQL, [id, clientId])).rows[0];
  if (!row) return null;
  return { snapshot: row.snapshot, source_hash: createHash("sha256").update(JSON.stringify(row.snapshot)).digest("hex") };
}

export async function lockLegacyOrderSource(db: Queryer, clientId: string, id: string) {
  const order = await db.query("SELECT id FROM public.commande_client WHERE id=$1::bigint AND client_id=$2 FOR UPDATE", [id, clientId]);
  if (!order.rows.length) return false;
  // Lock parent releases before taking the snapshot. Their FK blocks new child
  // lines, while the order lock blocks a concurrent new release or order edit.
  await db.query("SELECT id FROM public.commande_cadre_release WHERE commande_cadre_id=$1::bigint ORDER BY id FOR UPDATE", [id]);
  await db.query("SELECT id FROM public.commande_ligne WHERE commande_id=$1::bigint ORDER BY id FOR SHARE", [id]);
  await db.query(`SELECT article.id FROM public.articles article JOIN public.commande_ligne line ON line.article_id=article.id
    WHERE line.commande_id=$1::bigint ORDER BY article.id FOR SHARE OF article`, [id]);
  return true;
}

const ASSOCIATION_FIELDS = `legacy.id::text,legacy.contract_id::text,legacy.commande_id::text,legacy.contract_version,
  legacy.contract_snapshot->>'reference' AS reference,legacy.reason,legacy.actor_user_id,legacy.created_at::text`;
export async function readLegacyAssociation(db: Queryer, id: string) {
  return (await db.query<LegacyContractAssociation>(`SELECT ${ASSOCIATION_FIELDS}
    FROM public.client_contract_legacy_orders legacy WHERE legacy.commande_id=$1::bigint`, [id])).rows[0] ?? null;
}

export async function readRecordedLegacySource(db: Queryer, id: string) {
  return (await db.query<{source_snapshot: LegacyOrderSnapshot}>(
    "SELECT source_snapshot FROM public.client_contract_legacy_orders WHERE commande_id=$1::bigint", [id])).rows[0]?.source_snapshot ?? null;
}

export async function readLegacyAssociationReplay(db: Queryer, actor: number, key: string) {
  return (await db.query<LegacyContractAssociation & { request_hash: string }>(`SELECT ${ASSOCIATION_FIELDS},legacy.request_hash
    FROM public.client_contract_legacy_orders legacy WHERE legacy.actor_user_id=$1 AND legacy.idempotency_key=$2::uuid`, [actor, key])).rows[0] ?? null;
}

export async function listLegacyOrderCandidates(db: Queryer, clientId: string, contractId: string, page: number) {
  const { rows } = await db.query<{items: unknown[]; total: number}>(`WITH candidates AS (
    SELECT command.id::text,command.numero,command.code_client AS customer_reference,
    command.date_commande::text AS order_date,legacy.contract_id::text AS associated_contract_id,
    legacy.contract_snapshot->>'reference' AS associated_contract_reference,
    (SELECT count(*)::int FROM public.commande_ligne line WHERE line.commande_id=command.id) AS line_count
    FROM public.commande_client command LEFT JOIN public.client_contract_legacy_orders legacy ON legacy.commande_id=command.id
    WHERE command.client_id=$1 AND command.order_type='CADRE' AND (legacy.contract_id IS NULL OR legacy.contract_id=$2::uuid)
  ), selected AS (SELECT * FROM candidates ORDER BY id::bigint DESC LIMIT 25 OFFSET $3)
  SELECT COALESCE((SELECT jsonb_agg(selected ORDER BY id::bigint DESC) FROM selected),'[]'::jsonb) AS items,
    (SELECT count(*)::int FROM candidates) AS total`, [clientId, contractId, (page - 1) * 25]);
  return { items: rows[0].items, total: rows[0].total, page, page_size: 25 };
}

export async function hasFirmContractCall(db: Queryer, id: string) {
  return Boolean((await db.query("SELECT 1 FROM public.client_contract_calls WHERE commande_id=$1::bigint", [id])).rows.length);
}

export async function insertLegacyAssociation(db: Queryer, input: {
  id: string; contract: ClientContract; source: LegacyOrderSnapshot; sourceHash: string;
  mappings: LegacyContractMapping[]; actor: number; key: string; requestHash: string; reason: string;
}) {
  await db.query(`INSERT INTO public.client_contract_legacy_orders(id,contract_id,client_id,commande_id,contract_version,
    contract_snapshot,source_snapshot,source_hash,actor_user_id,idempotency_key,request_hash,reason)
    VALUES($1::uuid,$2::uuid,$3,$4::bigint,$5,$6::jsonb,$7::jsonb,$8,$9,$10::uuid,$11,$12)`,
    [input.id, input.contract.id, input.contract.client_id, input.source.id, input.contract.version,
      JSON.stringify(input.contract), JSON.stringify(input.source), input.sourceHash, input.actor, input.key, input.requestHash, input.reason]);
  for (const line of input.mappings) {
    await db.query(`INSERT INTO public.client_contract_legacy_lines(legacy_order_id,contract_id,contract_line_id,
      commande_ligne_id,article_id,root_article_id,piece_technique_version_id,unit_id,historical_line)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::jsonb)`,
      [input.id, input.contract.id, line.contract_line_id, line.commande_ligne_id, line.article_id, line.root_article_id,
        line.piece_technique_version_id, line.unit_id, JSON.stringify(line.historical_line)]);
  }
  const saved = await readLegacyAssociation(db, input.source.id);
  if (!saved) throw new Error("LEGACY_CONTRACT_ASSOCIATION_NOT_VISIBLE");
  return saved;
}
