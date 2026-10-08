import { assemblyComponentOperation } from './assembly-component-contract';
import { assemblyComponentReturnOperation } from './assembly-component-return-contract';
const root = '/terminals/operator/ofs/{of_id}/operations/{operation_id}/assembly-components';
export const TERMINAL_ASSEMBLY_OPERATIONS = [
  `get ${root}`, `post ${root}/withdraw`, `get ${root}/withdrawals`,
  `get ${root}/withdrawals/{withdrawal_id}/return`, `post ${root}/withdrawals/{withdrawal_id}/return`,
];
export function terminalAssemblyOperation(key: string, operation: Record<string, unknown>) {
  if (!TERMINAL_ASSEMBLY_OPERATIONS.includes(key)) return operation;
  const equivalent = key.replace(root, '/production/ofs/{id}/assembly-components').replace('{withdrawal_id}', '{withdrawalId}');
  const shared = assemblyComponentReturnOperation(equivalent, assemblyComponentOperation(equivalent, operation));
  const parameters: Array<Record<string, unknown>> = [
    { name: 'of_id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
    { name: 'operation_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
    ...((shared.parameters as Array<Record<string, unknown>>) ?? []).filter(p => p.in === 'query'),
  ];
  if (key.includes('{withdrawal_id}')) parameters.push({ name: 'withdrawal_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
  if (key.startsWith('post ')) parameters.push({ name: 'Idempotency-Key', in: 'header', required: true,
    description: 'Même UUID que le corps ; conserver la clé et le corps après réponse incertaine.', schema: { type: 'string', format: 'uuid' } });
  return { ...shared, parameters, 'x-cerp-rbac': [...((operation['x-cerp-rbac'] as string[]) ?? []),
    'releasedAssemblyOperationOnTerminalMachine', ...(key.startsWith('post ') ? ['stockAccountRights', 'transactionSessionScope'] : [])],
    'x-cerp-idempotency': key.startsWith('post ') ? 'required-in-body-and-header' : 'not-applicable' };
}
