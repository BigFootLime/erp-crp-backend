import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { parseCumpDecimal } from '../../stock/domain/cump-decimal';
import type { ContractCoverageSupply } from '../types/client-contract-coverage.types';
import type { ContractReplenishmentOpenIntent } from '../domain/client-contract-replenishment-intents';

type Tx = Pick<PoolClient, 'query'>;
export type ReplenishmentProducerIdentity = {
  evidence_id: string; root_of_id: string; article_id: string; unit: string; root_article_id: string; root_unit: string;
  target_date: string; quantity: string; scrap: string; received: string; released_attributed: string;
  status: string; order_line_id: string | null; group_id: string | null; share_id: string | null;
  producer_id: string | null; producer_article_id: string | null; producer_unit: string | null;
  producer_status: string | null; producer_scrap: string | null; producer_received: string | null;
  producer_attributed: string | null; share_quantity: string | null; share_received: string | null;
  root_identity_valid: boolean; producer_identity_valid: boolean | null;
};

/** Canonical identities are read from active consolidation allocations. The
 * original source is never counted beside its producer. Received attribution
 * evidence is immutable and includes FREE output, even after stock consumption.
 * Unsupported pending quality/group loss is explicit review, never guessed. */
export const REPLENISHMENT_PRODUCER_IDENTITIES_SQL = `WITH receipt_totals AS (
  SELECT r.of_id,sum(r.qty_ok)::text AS received,
    sum(COALESCE(attribution.quantity,0))::text AS attributed
  FROM public.of_receipts r LEFT JOIN LATERAL (
    SELECT sum(a.quantity) AS quantity FROM public.production_receipt_lane_assignments a WHERE a.receipt_id=r.id
  ) attribution ON true GROUP BY r.of_id
), identities AS (
  SELECT evidence.id::text AS evidence_id,evidence.root_of_id::text,evidence.article_id::text,
    upper(btrim(unit.code)) AS unit,source.article_id::text AS root_article_id,upper(btrim(article.unite)) AS root_unit,
    evidence.target_date::text,source.quantite_lancee::text AS quantity,source.quantite_rebut::text AS scrap,
    COALESCE((SELECT sum(output.qty_ok) FROM public.of_output_lots output WHERE output.of_id=source.id),0)::text AS received,
    COALESCE(receipt.attributed,'0') AS released_attributed,source.statut::text AS status,source.commande_ligne_id::text AS order_line_id,
    grouped.id::text AS group_id,share.id::text AS share_id,producer.id::text AS producer_id,
    producer.article_id::text AS producer_article_id,upper(btrim(producer_article.unite)) AS producer_unit,
    producer.statut::text AS producer_status,producer.quantite_rebut::text AS producer_scrap,
    COALESCE((SELECT sum(output.qty_ok) FROM public.of_output_lots output WHERE output.of_id=producer.id),0)::text AS producer_received,
    COALESCE(producer_receipt.attributed,'0') AS producer_attributed,
    share.quantity::text AS share_quantity,share.received_quantity::text AS share_received,
    (source.client_id::text=contract.client_id::text AND source.piece_technique_id=evidence.piece_technique_id
      AND COALESCE(source.technical_preparation->>'selected_version_id',source.piece_technique_version_id::text)
        =evidence.piece_technique_version_id::text) AS root_identity_valid,
    (producer.client_id::text=contract.client_id::text AND producer.piece_technique_id=evidence.piece_technique_id
      AND producer.piece_technique_version_id=evidence.piece_technique_version_id) AS producer_identity_valid
  FROM public.client_contract_replenishment_roots evidence
  JOIN public.ordres_fabrication source ON source.id=evidence.root_of_id
  JOIN public.client_contracts contract ON contract.id=evidence.contract_id
  JOIN public.units unit ON unit.id=evidence.unit_id JOIN public.articles article ON article.id=source.article_id
  LEFT JOIN receipt_totals receipt ON receipt.of_id=source.id
  LEFT JOIN public.production_consolidation_allocations share ON share.source_of_id=source.id AND share.state='ACTIVE'
    AND EXISTS(SELECT 1 FROM public.production_consolidations active WHERE active.id=share.consolidation_id AND active.state='ACTIVE')
  LEFT JOIN public.production_consolidations grouped ON grouped.id=share.consolidation_id AND grouped.state='ACTIVE'
  LEFT JOIN public.ordres_fabrication producer ON producer.id=grouped.producer_of_id
  LEFT JOIN public.articles producer_article ON producer_article.id=producer.article_id
  LEFT JOIN receipt_totals producer_receipt ON producer_receipt.of_id=producer.id
  WHERE evidence.article_id=ANY($1::uuid[])
) SELECT * FROM identities
  WHERE (group_id IS NOT NULL AND (producer_status NOT IN('ANNULE','TERMINE','CLOTURE')
    OR producer_received::numeric<>producer_attributed::numeric
    OR (producer_status<>'ANNULE' AND share_quantity::numeric>share_received::numeric)))
    OR (group_id IS NULL AND (status NOT IN('ANNULE','TERMINE','CLOTURE')
      OR received::numeric<>released_attributed::numeric
      OR (status<>'ANNULE' AND quantity::numeric>scrap::numeric+received::numeric)))
  ORDER BY root_of_id::bigint,evidence_id LIMIT 501`;

export function reconcileReplenishmentProducerIdentities(rows: readonly ReplenishmentProducerIdentity[], sources: readonly ContractCoverageSupply[]) {
  const fail = (message: string): never => { throw new HttpError(409, 'CONTRACT_REPLENISHMENT_INTENT_REVIEW_REQUIRED', message); };
  const seen = new Set<string>();
  return rows.map((row): ContractReplenishmentOpenIntent => {
    for (const quantity of [row.quantity,row.scrap,row.received,row.released_attributed,
      ...(row.group_id ? [row.producer_scrap,row.producer_received,row.producer_attributed,row.share_quantity,row.share_received] : [])]) {
      if (quantity === null || !/^\d+(\.\d{1,3})?$/.test(quantity) || parseCumpDecimal(quantity)>parseCumpDecimal('1000000000'))
        fail('Une quantité de producteur est incohérente. Vérifiez cet OF avant de relancer.');
    }
    if (seen.has(row.evidence_id)) fail('Un OF appartient à plusieurs regroupements actifs. Vérifiez ses affectations.');
    seen.add(row.evidence_id);
    if (!row.root_identity_valid || row.article_id !== row.root_article_id || row.unit !== row.root_unit)
      fail('L’article ou l’unité d’un OF anticipé a changé. Vérifiez sa définition.');
    const grouped = row.group_id !== null;
    if (grouped && (!row.producer_identity_valid || !row.producer_id || !row.share_id || row.producer_article_id !== row.article_id || row.producer_unit !== row.unit
      || parseCumpDecimal(row.share_quantity!) !== parseCumpDecimal(row.quantity) || parseCumpDecimal(row.received) !== 0n))
      fail('L’affectation du regroupement ne correspond plus à son OF source. Vérifiez le regroupement.');
    const received = grouped ? row.share_received! : row.received;
    const scrap = grouped ? '0' : row.scrap;
    const status = grouped ? row.producer_status : row.status;
    const producerReceived = grouped ? row.producer_received! : row.received;
    const attributed = grouped ? row.producer_attributed! : row.released_attributed;
    const reconciled = parseCumpDecimal(producerReceived) === parseCumpDecimal(attributed);
    const ambiguousLoss = grouped && parseCumpDecimal(row.producer_scrap!) !== 0n;
    const terminal = status === 'TERMINE' || status === 'CLOTURE';
    const remaining = parseCumpDecimal(row.quantity) - parseCumpDecimal(received) - parseCumpDecimal(scrap);
    if (remaining < 0n || parseCumpDecimal(attributed) > parseCumpDecimal(producerReceived))
      fail('Les quantités reçues ou affectées dépassent leur producteur. Vérifiez les réceptions.');
    const sourceId = grouped ? `production:${row.producer_id}:share:${row.share_id}` : `production:${row.root_of_id}`;
    // Only exact source identities published by the canonical coverage reader
    // may retire already secured allocations. No prefix/label alias matching.
    const coverage = sources.filter(source => source.id === sourceId);
    if (coverage.some(source => source.kind !== 'PRODUCTION' || source.article_id !== row.article_id || source.unit !== row.unit
      || source.order_line_id !== row.order_line_id || source.reference_id !== (grouped ? row.producer_id : row.root_of_id)))
      fail('La couverture publiée ne correspond plus au producteur attendu. Recalculez.');
    return { id: row.evidence_id, article_id: row.article_id, unit: row.unit, quantity: row.quantity,
      scrap_quantity: scrap, received_quantity: received, received_reconciled: reconciled,
      target_date: row.target_date, order_line_id: row.order_line_id,
      status: !reconciled || ambiguousLoss || (terminal && remaining !== 0n) ? 'REVIEW_REQUIRED' : status === 'ANNULE' ? 'CANCELLED' : 'OPEN',
      coverage_source_ids: coverage.map(source => source.id) };
  });
}

export async function readReplenishmentProducerIntents(tx: Tx, articleIds: readonly string[], sources: readonly ContractCoverageSupply[]) {
  const rows = (await tx.query<ReplenishmentProducerIdentity>(REPLENISHMENT_PRODUCER_IDENTITIES_SQL, [articleIds])).rows;
  if (rows.length > 500) throw new HttpError(422, 'CONTRACT_REPLENISHMENT_SCOPE_TOO_LARGE', 'Le calcul dépasse 500 OF anticipés. Réduisez le périmètre.');
  return reconcileReplenishmentProducerIdentities(rows, sources);
}
