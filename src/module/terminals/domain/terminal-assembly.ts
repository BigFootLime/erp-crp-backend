import { HttpError } from '../../../utils/httpError';
import type { OperationContext } from '../repository/terminal-dossier.repository';
import type { Terminal } from '../repository/terminal-auth.repository';

export function assertNativeAssemblyOperation(terminal: Terminal, context: OperationContext) {
  const frozen = Array.isArray(context.technical_snapshot?.operations) ? context.technical_snapshot.operations : [];
  const matches = frozen.filter((op: Record<string, unknown>) => String(op.phase) === String(context.phase));
  if (terminal.kind !== 'OPERATOR' || !terminal.machine_id || matches.length !== 1
    || matches[0].type_operation !== 'ASSEMBLAGE') {
    throw new HttpError(403, 'TERMINAL_ASSEMBLY_SCOPE', 'Ouvrez l’opération de montage affectée à ce poste.');
  }
}

export function assertNativeAssemblyCommandScope(operationId: string, bodyOperationId: string, bodyKey: string, headerKey: string) {
  if (operationId !== bodyOperationId || bodyKey !== headerKey) {
    throw new HttpError(422, 'TERMINAL_ASSEMBLY_SCOPE', 'La sortie doit correspondre au dossier et à la confirmation ouverts.');
  }
}
