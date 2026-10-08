type Schema = Record<string, unknown>;
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const uuid: Schema = { type: 'string', format: 'uuid' };
const ofId: Schema = { type: 'integer', minimum: 1 };
const quantity: Schema = { type: 'number', minimum: 0 };
const assemblyQuantity: Schema = { type: 'integer', minimum: 1, maximum: 1_000_000_000 };
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
export const assemblyComponentSchemas: Record<string, Schema> = {
  AssemblyComponentWithdrawal: object({ idempotencyKey: uuid, expectedVersion: { type: 'string', minLength: 1, maxLength: 128 }, operationId: uuid, quantity: assemblyQuantity }),
  AssemblyComponentWithdrawalResult: object({ ofId, operationId: uuid, assemblyQuantity,
    remaining: quantity, sourceAllocations: { type: 'array', items: object({ sourceOfId: ofId, assemblyQuantity }) },
    movements: { type: 'array', items: object({ requirementId: uuid, sourceOfId: ofId, reservationId: uuid, stockMovementId: uuid, quantity }) } }),
  AssemblyComponentPreparation: object({ ofId, number: { type: 'string' },
    operation: { nullable: true, ...object({ id: uuid, phase: { type: 'integer' }, label: { type: 'string' }, status: { type: 'string' } }) },
    version: { type: 'string' }, canWithdraw: { type: 'boolean' },
    blockers: { type: 'array', items: object({ code: { type: 'string' }, message: { type: 'string' } }) },
    coverage: { type: 'object', additionalProperties: true },
    permissions: object({ withdraw: { type: 'boolean' } }),
    balance: { nullable: true, ...object({ quantity, alreadyInAssembly: quantity, remaining: quantity,
      sourceBalances: { type: 'array', items: object({ sourceOfId: ofId, quantity, alreadyInAssembly: quantity, remaining: quantity }) } }) },
    plan: { nullable: true, ...object({ quantity: assemblyQuantity, alreadyInAssembly: quantity,
      remainingBefore: quantity, remainingAfter: quantity,
      sourceAllocations: { type: 'array', items: object({ sourceOfId: ofId, assemblyQuantity }) },
      allocations: { type: 'array', items: object({ requirementId: uuid, sourceOfId: ofId, label: { type: 'string' }, unit: { type: 'string' },
        reservationId: uuid, reservationVersion: { type: 'integer', minimum: 1 }, lotId: uuid, lotCode: { type: 'string', nullable: true }, quantity }) } }) },
  }),
};

export function assemblyComponentOperation(key: string, operation: Record<string, unknown>) {
  const read = key === 'get /production/ofs/{id}/assembly-components';
  const write = key === 'post /production/ofs/{id}/assembly-components/withdraw';
  if (!read && !write) return operation;
  const parameters = [{ name: 'id', in: 'path', required: true, schema: ofId }];
  const response = (name: string, description: string) => ({ description, content: { 'application/json': { schema: ref(name) } } });
  if (read) return { ...operation, summary: 'Préparer une mise en montage depuis la nomenclature et les lots réservés',
    parameters: [...parameters, { name: 'quantity', in: 'query', required: false, schema: assemblyQuantity }],
    responses: { ...(operation.responses as Record<string, unknown>), '200': response('AssemblyComponentPreparation', 'Quantité et sous-pièces préremplies ; blocages explicites et permission stock.') } };
  return { ...operation, summary: 'Confirmer une sortie physique de composants pour une quantité nouvellement mise en montage',
    parameters, 'x-cerp-idempotency': 'required-in-body',
    requestBody: { required: true, content: { 'application/json': { schema: ref('AssemblyComponentWithdrawal') } } },
    responses: { ...(operation.responses as Record<string, unknown>), '200': response('AssemblyComponentWithdrawalResult', 'Preuve originale retrouvée sur rejeu ; toutes les sorties sont enregistrées dans une transaction.'),
      '403': { description: 'Droits production ou stock insuffisants.' }, '409': { description: 'Préparation modifiée, composants indisponibles ou nomenclature à rapprocher.' },
      '503': { description: 'Résultat incertain : conserver la même clé et le même corps pour le rapprochement.' } } };
}
