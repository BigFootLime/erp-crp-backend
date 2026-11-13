const uuid = { type: 'string', format: 'uuid' }, text = { type: 'string' }, number = { type: 'number' };
const nullable = (schema: Record<string, unknown>) => ({ ...schema, nullable: true });
export function supplierRecommendationOperation(key: string, operation: Record<string, unknown>) {
  if (key !== 'get /production/ofs/{id}/supplier-recommendations') return operation;
  const criterion = { type: 'object', required: ['available', 'weight', 'points'], properties: {
    available: { type: 'boolean' }, weight: number, points: number } };
  const sources = { type: 'object', required: ['order', 'catalogue', 'reviews'], properties: {
    order: { type: 'object', nullable: true, required: ['id', 'code', 'sent_at'],
      properties: { id: uuid, code: nullable(text), sent_at: nullable(text) } },
    catalogue: { type: 'object', nullable: true, required: ['id', 'version', 'comparable_price'],
      properties: { id: uuid, version: text, comparable_price: { type: 'boolean' } } },
    reviews: { type: 'array', maxItems: 4000, items: { type: 'object', required: ['id', 'evaluated_on', 'outcome', 'quality_score', 'domain'],
      properties: { id: uuid, evaluated_on: text, outcome: text, quality_score: nullable(number), domain: nullable(text) } } },
  } };
  const suggestion = { type: 'object', required: ['supplier_id', 'supplier_name', 'sent_orders', 'received_orders', 'can_engage',
    'qualification_known', 'estimated_ht', 'confidence', 'score', 'ranking', 'sources'], properties: {
    supplier_id: uuid, supplier_name: text, sent_orders: { type: 'integer', minimum: 0 }, received_orders: { type: 'integer', minimum: 0 },
    actual_days: nullable(number), can_engage: { type: 'boolean' }, qualification_known: { type: 'boolean' },
    review_outcome: nullable(text), estimated_ht: nullable(number), currency: text,
    catalogue_id: nullable(uuid), purchase_quantity: nullable(number), purchase_unit: nullable(text), announced_days: nullable(number),
    score: number, confidence: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    ranking: { type: 'object', required: ['price', 'history', 'delay', 'quality'], properties: { price: criterion, history: criterion, delay: criterion, quality: criterion } },
    sources, reasons: { type: 'array', items: text }, warnings: { type: 'array', items: text },
  } };
  return { ...operation, summary: 'Proposer les fournisseurs avec leurs preuves ERP',
    description: 'Lecture OF et capacité création achats. Estimation pour article/quantité/unité/devise explicites, historique envoyé sur 24 mois, catalogue et évaluations valides. REPEATABLE READ READ ONLY, SQL 2 s / transaction PostgreSQL 17 de 9 s. Contexte OF/version, empreinte des preuves et contributions au classement ; le score n’est pas la confiance. Prix réservés aux lecteurs autorisés. Aucun achat, choix, réservation ou apprentissage écrit par ce GET.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
      { name: 'articleId', in: 'query', required: true, schema: uuid },
      { name: 'quantity', in: 'query', schema: { type: 'number', exclusiveMinimum: true, minimum: 0, maximum: 1e9 } },
      { name: 'unit', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 30 } },
      { name: 'currency', in: 'query', schema: { type: 'string', pattern: '^[A-Z]{3}$', default: 'EUR' } }],
    responses: { '200': { description: 'Sources comparables et suggestion explicite, ou aucun recommandé.', content: { 'application/json': {
      schema: { type: 'object', required: ['data'], properties: { data: { type: 'object',
        required: ['checked_at', 'article_id', 'recommended_supplier_id', 'can_read_prices', 'truncated', 'history_months', 'cost_scope', 'context', 'policy', 'source_sha256', 'items'],
        properties: { checked_at: text, article_id: uuid, recommended_supplier_id: nullable(uuid), can_read_prices: { type: 'boolean' },
          truncated: { type: 'boolean' }, history_months: { type: 'integer', enum: [24] },
          cost_scope: { type: 'string', enum: ['ONE_CATALOGUE_LINE_EXCLUDING_FREIGHT'] },
          context: { type: 'object', required: ['of_id', 'of_updated_at', 'technical_version_id', 'article_id', 'quantity', 'unit', 'currency'],
            properties: { of_id: { type: 'integer' }, of_updated_at: text, technical_version_id: nullable(uuid), article_id: uuid,
              quantity: nullable(number), unit: nullable(text), currency: text } },
          policy: { type: 'object', required: ['id', 'mode', 'history_months', 'weights', 'requires_confirmation', 'score_is_confidence', 'priority'],
            properties: { id: { type: 'string', enum: ['supplier-history-v2'] }, mode: { type: 'string', enum: ['ERP_DATA'] },
              history_months: { type: 'integer', enum: [24] }, weights: { type: 'object', properties: { price: number, history: number, delay: number, quality: number } },
              requires_confirmation: { type: 'boolean', enum: [true] }, score_is_confidence: { type: 'boolean', enum: [false] },
              priority: { type: 'array', items: text } } },
          source_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, items: { type: 'array', maxItems: 40, items: suggestion },
        } } } } } } }, '400': { description: 'Paramètres invalides.' }, '401': { description: 'Authentification requise.' },
      '403': { description: 'Lecture OF et création achats requises.' }, '404': { description: 'OF introuvable.' },
      '409': { description: 'Article hors dossier actuel ou preuves trop volumineuses.' } },
    'x-cerp-rbac': [...((operation['x-cerp-rbac'] as string[]) ?? []), 'of:read', 'commande_fournisseur:create', 'prices:conditional'],
  };
}
