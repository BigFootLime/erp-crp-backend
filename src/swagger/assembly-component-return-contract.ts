type Schema = Record<string, unknown>;
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const uuid: Schema = { type: 'string', format: 'uuid' };
const ofId: Schema = { type: 'integer', minimum: 1 };
const assemblyQuantity: Schema = { type: 'integer', minimum: 1 };
const quantity: Schema = { type: 'number', minimum: 0, exclusiveMinimum: true };
const sourceAllocations: Schema = { type: 'array', items: object({ sourceOfId: ofId, assemblyQuantity }) };
const movement = { requirementId: uuid, sourceOfId: ofId, reservationId: uuid, stockMovementId: uuid, quantity };
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

export const assemblyComponentReturnSchemas: Record<string, Schema> = {
  AssemblyComponentWithdrawals: object({ ofId, items: { type: 'array', maxItems: 50,
    items: object({ id: uuid, createdAt: { type: 'string' }, returned: { type: 'boolean' }, proofAvailable: { type: 'boolean' },
      operationId: { ...uuid, nullable: true }, assemblyQuantity: { ...assemblyQuantity, nullable: true } }) } }),
  AssemblyComponentReturn: object({ idempotencyKey: uuid, expectedVersion: { type: 'string', minLength: 1, maxLength: 128 },
    reason: { type: 'string', minLength: 3, maxLength: 1000 }, confirmPhysicalReturn: { type: 'boolean', enum: [true] } }),
  AssemblyComponentReturnPreview: object({ ofId, withdrawalId: uuid, createdAt: { type: 'string' }, assemblyQuantity, sourceAllocations,
    operation: { nullable: true, ...object({ id: uuid, phase: { type: 'integer' }, label: { type: 'string' }, status: { type: 'string' } }) },
    version: { type: 'string' }, canReturn: { type: 'boolean' },
    blockers: { type: 'array', items: object({ code: { type: 'string' }, message: { type: 'string' } }) },
    permissions: object({ return: { type: 'boolean' } }),
    movements: { type: 'array', items: object({ ...movement, lotId: { ...uuid, nullable: true },
      lotCode: { type: 'string', nullable: true }, label: { type: 'string' }, unit: { type: 'string', nullable: true } }) } }),
  AssemblyComponentReturnResult: object({ ofId, withdrawalId: uuid, assemblyQuantity, sourceAllocations,
    movements: { type: 'array', items: object({ ...movement, originalMovementId: uuid }) } }),
};

export function assemblyComponentReturnOperation(key: string, operation: Record<string, unknown>) {
  const history = key === 'get /production/ofs/{id}/assembly-components/withdrawals';
  const preview = key === 'get /production/ofs/{id}/assembly-components/withdrawals/{withdrawalId}/return';
  const submit = key === 'post /production/ofs/{id}/assembly-components/withdrawals/{withdrawalId}/return';
  if (!history && !preview && !submit) return operation;
  const parameters = [{ name: 'id', in: 'path', required: true, schema: ofId },
    ...(!history ? [{ name: 'withdrawalId', in: 'path', required: true, schema: uuid }] : [])];
  const response = (name: string, description: string) => ({ description, content: { 'application/json': { schema: ref(name) } } });
  const responses = { ...(operation.responses as Record<string, unknown>),
    '200': response(history ? 'AssemblyComponentWithdrawals' : preview ? 'AssemblyComponentReturnPreview' : 'AssemblyComponentReturnResult',
      history ? 'Cinquante dernières mises en montage, preuves et retours conservés.' : preview ? 'Lots et quantités de la sortie préremplis, usage aval et qualité vérifiés.' : 'Mouvements inverses et réservations restaurés atomiquement ; preuve originale retrouvée au rejeu.'),
    '403': { description: 'Droits production ou correction stock insuffisants.' },
    '409': { description: 'Usage aval, réservation ou qualité modifiée ; aucun retour partiel conservé.' } };
  return { ...operation, parameters, responses,
    summary: history ? 'Lister les mises en montage physiques' : preview ? 'Préparer la restitution d’une mise en montage inutilisée' : 'Confirmer le retour physique de tous les composants d’une mise inutilisée',
    ...(submit ? { 'x-cerp-idempotency': 'required-in-body', requestBody: { required: true,
      content: { 'application/json': { schema: ref('AssemblyComponentReturn') } } } } : {}) };
}
