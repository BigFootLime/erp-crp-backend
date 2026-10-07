import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { OF_PURCHASE_SCOPE_SQL } from './of-supplier-qualification.repository';
import { readOfPurchaseClientContextsTx } from '../../commande-fournisseur/repository/purchase-client-context.repository';
import { readSupplierPurchaseQualificationTx } from '../../commande-fournisseur/repository/purchase-qualification.repository';
import { purchaseLineDomains, type PurchaseScopeLine, type QualificationDecision } from '../../fournisseurs/domain/purchase-qualification';
import { readApprovalPoliciesTx } from '../../fournisseurs/repository/client-supplier-approval.repository';
import { estimateRecommendationPrice, rankSupplierSuggestions, summarizeSupplierQualification,
  type RecommendationCatalogue, type SupplierHistory, type SupplierReview, type SupplierSuggestion } from '../../commande-fournisseur/domain/supplier-recommendation';

// Only actual sent orders of this exact article teach a preference. A receipt
// counts as completed only after closed, physical receipts cover the whole line.
export const SUPPLIER_RECOMMENDATION_HISTORY_SQL = `WITH lines AS (
  SELECT l.id,c.id AS order_id,c.code,c.fournisseur_id,c.date_envoi,
    l.quantite-l.qty_annulee AS quantity,
    r.received,r.last_date
  FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id
  LEFT JOIN LATERAL (SELECT sum(rl.qty_received) AS received,max(rh.reception_date) AS last_date
    FROM public.reception_fournisseur_lignes rl JOIN public.receptions_fournisseurs rh ON rh.id=rl.reception_id
    WHERE rl.commande_fournisseur_ligne_id=l.id AND rh.status='CLOSED') r ON true
  WHERE l.article_id=$1::uuid AND l.statut_ligne='ACTIVE' AND l.quantite>l.qty_annulee
    AND c.date_envoi IS NOT NULL AND c.statut IN ('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE','RECUE','CLOTUREE')
    AND c.date_envoi>=statement_timestamp()-interval '24 months'
), orders AS (
  SELECT fournisseur_id,order_id,code,date_envoi,bool_and(COALESCE(received,0)>=quantity) AS completed,
    max(last_date) AS last_date FROM lines GROUP BY fournisseur_id,order_id,code,date_envoi
), history AS (
  SELECT fournisseur_id,count(*)::int AS sent_orders,count(*) FILTER(WHERE completed)::int AS received_orders,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY last_date-(date_envoi AT TIME ZONE 'Europe/Paris')::date)
      FILTER(WHERE completed AND last_date>=(date_envoi AT TIME ZONE 'Europe/Paris')::date)::float8 AS actual_days
  FROM orders GROUP BY fournisseur_id
), candidates AS (
  SELECT fournisseur_id FROM history UNION SELECT fournisseur_id FROM public.fournisseur_catalogue
  WHERE article_id=$1::uuid AND actif AND (valid_from IS NULL OR valid_from<=$2::date) AND (valid_to IS NULL OR valid_to>=$2::date)
) SELECT f.id::text AS supplier_id,COALESCE(NULLIF(f.nom,''),f.raison_sociale,f.code) AS supplier_name,
  COALESCE(h.sent_orders,0)::int AS sent_orders,COALESCE(h.received_orders,0)::int AS received_orders,h.actual_days,
  recent.order_id::text AS last_order_id,recent.code AS last_order_code,recent.date_envoi::text AS last_order_at
FROM candidates c JOIN public.fournisseurs f ON f.id=c.fournisseur_id LEFT JOIN history h ON h.fournisseur_id=f.id
LEFT JOIN LATERAL(SELECT * FROM orders o WHERE o.fournisseur_id=f.id ORDER BY date_envoi DESC,order_id DESC LIMIT 1) recent ON true
WHERE f.actif IS NOT FALSE AND COALESCE(f.status,'actif') NOT IN ('inactif','archive')
ORDER BY COALESCE(h.sent_orders,0) DESC,recent.date_envoi DESC NULLS LAST,f.id LIMIT 41`;

export const SUPPLIER_RECOMMENDATION_CATALOGUES_SQL = `SELECT id::text AS catalogue_id,fournisseur_id::text AS supplier_id,
  updated_at::text AS version,unite AS unit,devise AS currency,prix_unitaire::float8,
  forfait_ht::float8,minimum_facturation_ht::float8,moq::float8,COALESCE(price_tiers,'[]'::jsonb) AS price_tiers,
  unite_stock AS stock_unit,coef_conversion::float8 AS coefficient,lot_achat::float8 AS pack,
  pricing_basis,prix_multiple::float8 AS price_multiple,delai_jours::int AS delay_days,type
FROM public.fournisseur_catalogue WHERE article_id=$1::uuid AND fournisseur_id=ANY($2::uuid[]) AND actif
  AND (valid_from IS NULL OR valid_from<=$3::date) AND (valid_to IS NULL OR valid_to>=$3::date)
ORDER BY fournisseur_id,updated_at DESC,id LIMIT 400`;

export const SUPPLIER_RECOMMENDATION_REVIEWS_SQL = `SELECT s.supplier_id::text,s.domaine_code AS domain,e.id::text,
  e.evaluated_on::text,e.outcome,e.quality_score::int
FROM public.supplier_review_scopes s JOIN LATERAL (
  SELECT x.* FROM public.supplier_review_evaluations x WHERE x.scope_id=s.id
    AND NOT EXISTS(SELECT 1 FROM public.supplier_review_evaluations correction WHERE correction.supersedes_id=x.id)
  ORDER BY x.evaluated_on DESC,x.created_at DESC LIMIT 1
) e ON true WHERE s.supplier_id=ANY($1::uuid[]) AND (s.domaine_code IS NULL OR s.domaine_code=ANY($2::text[]))
  AND e.evaluated_on<=$3::date AND e.next_due>$3::date`;

export const SUPPLIER_RECOMMENDATION_QUALIFICATIONS_SQL = `SELECT fournisseur_id::text AS supplier_id,
  id::text,version,statut,domaine_code,valid_from::text,valid_to::text,document_id::text,
  reference,organisme,perimetre,updated_at::text FROM public.fournisseur_homologations
WHERE fournisseur_id=ANY($1::uuid[]) AND is_current AND (domaine_code IS NULL OR domaine_code=ANY($2::text[]))
ORDER BY fournisseur_id,domaine_code NULLS FIRST`;

export async function getOfSupplierRecommendations(ofId: number,
  input: { articleId: string; quantity?: number; unit?: string; currency: string }, canReadPrices: boolean) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const scope = (await tx.query<PurchaseScopeLine>(OF_PURCHASE_SCOPE_SQL, [ofId, input.articleId])).rows[0];
    if (!scope) throw new HttpError(409, 'OF_PURCHASE_ARTICLE_NOT_APPLICABLE', 'Cet article ne fait pas partie des achats actuels de cet OF.');
    const clock = (await tx.query<{ today: string; checked_at: string }>(`SELECT
      (statement_timestamp() AT TIME ZONE 'Europe/Paris')::date::text AS today,statement_timestamp()::text AS checked_at`)).rows[0];
    const contexts = await readOfPurchaseClientContextsTx(tx, ofId, input.articleId);
    const rows = (await tx.query<SupplierHistory>(SUPPLIER_RECOMMENDATION_HISTORY_SQL, [input.articleId, clock.today])).rows;
    const candidates = rows.slice(0,40), ids = candidates.map(item => item.supplier_id), domains = purchaseLineDomains(scope);
    const catalogues = (await tx.query<RecommendationCatalogue>(SUPPLIER_RECOMMENDATION_CATALOGUES_SQL, [input.articleId, ids, clock.today])).rows;
    const reviews = (await tx.query<SupplierReview>(SUPPLIER_RECOMMENDATION_REVIEWS_SQL, [ids, domains, clock.today])).rows;
    const decisions = (await tx.query<QualificationDecision & { supplier_id:string }>(SUPPLIER_RECOMMENDATION_QUALIFICATIONS_SQL,[ids,domains])).rows;
    const policies = await readApprovalPoliciesTx(tx,[...new Set(contexts.map(context=>context.client_id))].sort(),false);
    const suggestions: SupplierSuggestion[] = [];
    for (const item of candidates) {
      const qualification = summarizeSupplierQualification(await readSupplierPurchaseQualificationTx(tx,
        { supplierId: item.supplier_id, today: clock.today, checkedAt: clock.checked_at, lines:[scope], contexts,
          prefetched:{decisions:decisions.filter(decision=>decision.supplier_id===item.supplier_id),policies} }));
      const offers = catalogues.filter(offer => offer.supplier_id === item.supplier_id &&
        purchaseLineDomains({ ...scope, categories: [], catalogue_type: offer.type }).some(domain => domains.includes(domain)));
      const prices = canReadPrices ? offers.flatMap(offer => {
        const price = estimateRecommendationPrice(offer, input.quantity, input.unit, input.currency);
        return price ? [{ offer, price }] : [];
      }).sort((a,b) => a.price.total-b.price.total || a.offer.catalogue_id.localeCompare(b.offer.catalogue_id)) : [];
      const offer = prices[0]?.offer ?? offers[0] ?? null;
      const relevantReviews = reviews.filter(review => review.supplier_id === item.supplier_id);
      const quality = relevantReviews.flatMap(review => review.quality_score === null ? [] : [review.quality_score]);
      const outcome = relevantReviews.some(review => review.outcome==='UNSATISFACTORY') ? 'UNSATISFACTORY'
        : relevantReviews.some(review => review.outcome==='RESERVATIONS') ? 'RESERVATIONS' : relevantReviews.length ? 'SATISFACTORY' : null;
      const reasons = [item.sent_orders ? `${item.sent_orders} commande(s) envoyée(s) pour cet article` : 'Conditions catalogue actuelles'];
      if (item.actual_days !== null) reasons.push(`${item.received_orders} commande(s) reçue(s), délai médian ${item.actual_days} jours calendaires`);
      if (prices[0]) reasons.push('Tarif actuel avec forfait, minimum et conditionnement');
      const warnings: string[] = [];
      if (!qualification.can_engage) warnings.push('Homologation ou exigence client bloquante');
      if (!qualification.known) warnings.push('Des homologations ou agréments restent à renseigner');
      if (outcome==='UNSATISFACTORY') warnings.push('Dernière évaluation non satisfaisante : avis Qualité nécessaire');
      if (outcome==='RESERVATIONS') warnings.push('Dernière évaluation avec réserves');
      if (canReadPrices && !prices.length) warnings.push('Aucun tarif comparable pour cette quantité, unité et devise');
      suggestions.push({ ...item, can_engage: qualification.can_engage, qualification_known: qualification.known,
        review_outcome: outcome, review_ids: relevantReviews.map(review => review.id), quality_score: quality.length ? Math.min(...quality) : null,
        catalogue_id: offer?.catalogue_id ?? null, estimated_ht: prices[0]?.price.total ?? null,
        purchase_quantity: prices[0]?.price.quantity ?? null, purchase_unit: offer?.unit ?? null,
        currency: input.currency, announced_days: offer?.delay_days ?? null, score: 0,
        confidence: item.sent_orders>=5 && item.received_orders>=3 && qualification.known && quality.length ? 'HIGH' : item.sent_orders>=3 ? 'MEDIUM' : 'LOW', reasons, warnings });
    }
    const sorted = rankSupplierSuggestions(suggestions, canReadPrices);
    const recommended = sorted.find(item => item.can_engage && item.review_outcome!=='UNSATISFACTORY' && (item.sent_orders>0 || item.estimated_ht!==null));
    await tx.query('COMMIT');
    return { data: { checked_at: clock.checked_at, article_id: input.articleId, recommended_supplier_id: recommended?.supplier_id ?? null,
      can_read_prices: canReadPrices, truncated: rows.length>40 || catalogues.length===400, history_months:24,
      cost_scope:'ONE_CATALOGUE_LINE_EXCLUDING_FREIGHT', items:sorted } };
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
