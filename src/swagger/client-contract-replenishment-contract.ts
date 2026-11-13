type Schema = Record<string, any>;
const text = { type: 'string' }, uuid = { ...text, format: 'uuid' }, version = { type: 'integer', minimum: 1, maximum: 2147483646 };
const month = { ...text, pattern: '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$' }, date = { ...text, format: 'date' };
const hash = { ...text, pattern: '^[0-9a-f]{64}$' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Schema): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const plan = ref('ClientContractReplenishmentPlan'), result = ref('ClientContractReplenishmentResult');
export const clientContractReplenishmentSchemas: Schema = {
  ClientContractReplenishmentProposal: object({ id: uuid, plan_id: uuid, contract_line_id: uuid, article: ref('ClientContractArticle'),
    month, target_date: date, target_overdue: { type: 'boolean' }, lot_quantity: text, lot_count: { ...text, pattern: '^[1-9][0-9]*$' },
    proposed_quantity: text, surplus_quantity: text }),
  ClientContractReplenishmentPlan: object({ id: uuid, contract_id: uuid, contract_version: version,
    status: { ...text, enum: ['CURRENT', 'SUPERSEDED'] }, purpose: { ...text, enum: ['PREPARATION_ONLY'] },
    fingerprint: hash, coverage_snapshot_hash: hash, start_month: month, months: { type: 'integer', minimum: 1, maximum: 36 },
    as_of_date: date, created_at: { ...text, format: 'date-time' }, created_by: version, actor_label: text,
    proposals: { type: 'array', items: ref('ClientContractReplenishmentProposal') } }),
  ClientContractReplenishmentResult: object({ event_id: uuid, unchanged: { type: 'boolean' }, plan }),
  ClientContractReplenishmentCurrent: object({ plan: { allOf: [plan], nullable: true } }),
  ClientContractReplenishmentHistory: object({ plan, history: object({ page: version, page_size: { type: 'integer', enum: [25] },
    total: { type: 'integer', minimum: 0 }, items: { type: 'array', maxItems: 25, items: object({ id: uuid,
      created_at: { ...text, format: 'date-time' }, actor_label: text, previous_plan_id: { ...uuid, nullable: true }, result_payload: result }) } }) }),
  ClientContractReplenishmentCommand: object({ action: { ...text, enum: ['PREPARE'] }, expected_contract_version: version,
    expected_plan_id: { ...uuid, nullable: true }, expected_snapshot_hash: hash, start_month: month, months: { type: 'integer', minimum: 1, maximum: 36 } }),
};
export function clientContractReplenishmentOperation(key: string, operation: Schema): Schema {
  const root = '/clients/{id}/contracts/{contractId}/replenishment';
  if (![ `get ${root}`, `get ${root}/{planId}/history`, `post ${root}/commands` ].includes(key)) return operation;
  const write = key.startsWith('post '), history = key.endsWith('/history');
  const parameters: Schema[] = [{ name: 'id', in: 'path', required: true, schema: text },
    { name: 'contractId', in: 'path', required: true, schema: uuid }];
  if (history) parameters.push({ name: 'planId', in: 'path', required: true, schema: uuid });
  const response = (schema: Schema, description: string) => ({ description, content: { 'application/json': { schema } } });
  const errors = { ...operation.responses, '404': { description: 'Client, contrat ou préparation introuvable.' },
    '409': { description: 'Version, stock, planning, préparation ou tentative périmés. Recalculer ; aucune écriture partielle.' },
    '422': { description: 'Horizon, preuve ou quantité hors périmètre.' } };
  if (write) return { ...operation, summary: 'Conserver les propositions de lots du contrat',
    description: 'Recalcule la couverture partagée dans la transaction, vérifie le hash affiché et conserve des propositions immuables. Aucun OF, achat, stock ou réservation n’est créé. Les quantités viennent du serveur. Une nouvelle préparation remplace seulement le plan courant et conserve son historique. Même tentative : résultat original ; même calcul avec nouvelle clé : identité de plan conservée. La création d’OF reste une action distincte, soumise à la capacité production.',
    parameters: [...parameters, { name: 'Idempotency-Key', in: 'header', required: true, schema: uuid }],
    requestBody: { required: true, content: { 'application/json': { schema: ref('ClientContractReplenishmentCommand') } } },
    responses: { ...errors, '200': response(result, 'Résultat original rejoué.'), '201': response(result, 'Préparation, historique, audit et outbox enregistrés ensemble.'),
      '503': { description: 'Résultat incertain : conserver la même commande et la même clé.' } }, 'x-cerp-idempotency': 'required' };
  parameters.push({ name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100000, default: 1 } });
  return { ...operation, summary: history ? 'Historique immuable de la préparation' : 'Dernière préparation de réapprovisionnement du contrat',
    description: 'Lecture uniquement. Une préparation n’est pas du stock disponible ni un OF engagé.', parameters,
    responses: { ...errors, '200': response(history ? ref('ClientContractReplenishmentHistory') : ref('ClientContractReplenishmentCurrent'), 'Préparation historisée, sans effet de bord.') } };
}
