const uuid = { type: 'string', format: 'uuid' };
const digest = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const decimal = { type: 'string', pattern: '^(0|[1-9][0-9]{0,25})(\\.[0-9]{1,12})?$' };
const signedDecimal = { ...decimal, pattern: '^-?(0|[1-9][0-9]{0,25})(\\.[0-9]{1,12})?$' };

export function stockValueAdjustmentOperation(key: string, operation: Record<string, unknown>) {
  if (!/^(get|post) \/margins\/stock-value\/\{articleId\}\/\{unit\}\/(candidate|adjustments)$/.test(key)) return operation;
  const candidate = key.endsWith('/candidate'), write = key.startsWith('post ');
  const adjustment = { type: 'object', required: ['id', 'entry_id', 'article_id', 'quantity', 'previous_value_ht',
    'total_value_ht', 'value_delta', 'previous_entry_id', 'document_id', 'source_reliability', 'source_sha256', 'source_valid'],
    properties: { id: uuid, entry_id: uuid, article_id: uuid, owner_key: { type: 'string', enum: ['COMPANY'] },
      stock_unit: { type: 'string' }, currency: { type: 'string', enum: ['EUR'] }, quantity: decimal,
      previous_value_ht: { ...decimal, nullable: true }, total_value_ht: decimal,
      value_delta: { ...signedDecimal, nullable: true }, previous_entry_id: uuid, document_id: uuid, document_sha256: digest,
      source_reliability: { type: 'string', enum: ['DECLARED'] }, source_sha256: digest, source_valid: { type: 'boolean' },
      created_by: { type: 'integer' }, created_at: { type: 'string' } } };
  const response = candidate ? { type: 'object', required: ['article_id', 'owner', 'unit', 'currency', 'eligible',
    'quantity', 'current_value_ht', 'source_sha256', 'source_reliability', 'documents', 'documents_truncated', 'issues'],
    properties: { article_id: uuid, owner: { type: 'string', enum: ['COMPANY'] }, unit: { type: 'string' },
      currency: { type: 'string', enum: ['EUR'] }, eligible: { type: 'boolean' }, quantity: { ...decimal, nullable: true },
      current_value_ht: { ...decimal, nullable: true }, source_sha256: digest,
      source_reliability: { type: 'string', enum: ['DECLARED'] },
      documents: { type: 'array', maxItems: 100, items: { type: 'object', properties: { id: uuid, name: { type: 'string' }, sha256: digest } } },
      documents_truncated: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } } }
    : write ? { type: 'object', required: ['adjustment', 'replayed'], properties: { adjustment, replayed: { type: 'boolean' } } }
    : { type: 'object', required: ['items', 'truncated'], properties: { items: { type: 'array', maxItems: 100, items: adjustment }, truncated: { type: 'boolean' } } };
  const content = { 'application/json': { schema: response } };
  return { ...operation, summary: candidate ? 'Préparer une correction de valeur du stock' : write ? 'Déclarer une correction de valeur' : 'Historique des corrections de valeur',
    description: 'Montant HT EUR justifié pour le stock entreprise actuel entier ; quantité inchangée et historique conservé. Projecteur ACTIVE initialisé et rapproché, preuve du solde et document actif de l’article requis. Fiabilité DECLARED. Une valeur précédente inconnue reste inconnue, avec écart null. Aucune ventilation automatique de facture tardive ni activation du projecteur.',
    parameters: [{ name: 'articleId', in: 'path', required: true, schema: uuid }, { name: 'unit', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 32 } }],
    ...(write ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false,
      required: ['request_id', 'expected_source_sha256', 'document_id', 'expected_document_sha256', 'total_value_ht'],
      properties: { request_id: uuid, expected_source_sha256: digest, document_id: uuid, expected_document_sha256: digest, total_value_ht: decimal } } } } } } : {}),
    responses: { ...((operation.responses as Record<string, unknown>) ?? {}),
      '200': { description: write ? 'Validation identique déjà enregistrée.' : 'Proposition ou historique documenté.', content },
      ...(write ? { '201': { description: 'Correction, écriture financière, solde et audit conservés atomiquement.', content } } : {}),
      '404': { description: 'Article introuvable.' }, '409': { description: 'Projecteur non actif, preuve modifiée, rapprochement incomplet ou validation concurrente.' } },
    'x-cerp-rbac': [...((operation['x-cerp-rbac'] as string[]) ?? []), write ? 'margin:snapshot' : 'margin:read_costs'] };
}
