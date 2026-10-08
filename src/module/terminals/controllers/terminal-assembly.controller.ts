import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { asyncHandler } from '../../../utils/asyncHandler';
import { HttpError } from '../../../utils/httpError';
import pool from '../../../config/database';
import { runWithAccountModuleAccessScope } from '../../access-control/context/account-module-access.context';
import { resolveAccessProfile } from '../../access-control/services/access-control.service';
import { consumableAccountRights } from '../../stock/domain/consumable-access';
import { canReturnAssemblyComponents } from '../../production/domain/assembly-component-access';
import { OF_ASSEMBLY_OPERATIONS_SQL } from '../../production/repository/of-component-coverage.sql';
import { buildAuditContext } from '../../production/controllers/production.controller';
import { assemblyComponentPreviewSchema, assemblyComponentWithdrawalSchema, assemblyComponentReturnSchema } from '../../production/validators/assembly-component-consumption.validators';
import { getAssemblyComponentPreparation, withdrawAssemblyComponents, getAssemblyComponentWithdrawals,
  getAssemblyComponentReturn, returnAssemblyComponents } from '../../production/services/assembly-component-consumption.service';
import { scopeSchema, commandKey } from '../validators/terminals.validators';
import { operationContext } from '../repository/terminal-dossier.repository';
import { authorizeNativeTerminalSessionTx } from '../repository/native-terminal-session.repository';
import { NATIVE_TERMINAL_ACCESS_LOCK_SQL } from '../repository/native-terminal-session.sql';
import { assertNativeAssemblyOperation, assertNativeAssemblyCommandScope } from '../domain/terminal-assembly';

const scope = (req: Request) => scopeSchema.parse({ of_id: req.params.of_id, operation_id: req.params.operation_id });
const audit = (req: Request) => ({ ...buildAuditContext(req), user_id: req.station!.user.id,
  user_role: req.station!.user.role, device_type: 'ANDROID_TERMINAL', page_key: 'terminal.assembly' });
async function scoped(req: Request, tx?: PoolClient) {
  const s = scope(req);
  assertNativeAssemblyOperation(req.terminal!, await operationContext(req.terminal!, s.of_id, s.operation_id, tx));
  const first = (await (tx ?? pool).query<{ id: string }>(OF_ASSEMBLY_OPERATIONS_SQL, [s.of_id])).rows[0];
  if (first?.id !== s.operation_id) throw new HttpError(403, 'TERMINAL_ASSEMBLY_SCOPE', 'Ouvrez la première opération de montage.');
  return s;
}
async function canWithdraw(req: Request) {
  let rights!: ReturnType<typeof consumableAccountRights>;
  runWithAccountModuleAccessScope(() => { rights = consumableAccountRights(req); });
  return (await rights).withdraw;
}
async function assertWrite(req: Request, returning: boolean) {
  if (!(returning ? await canReturnAssemblyComponents(req) : await canWithdraw(req))) {
    throw new HttpError(403, returning ? 'ASSEMBLY_COMPONENT_RETURN_FORBIDDEN' : 'ASSEMBLY_COMPONENT_WITHDRAWAL_FORBIDDEN',
      'Les droits Stock sont nécessaires pour cette action.');
  }
}
const authorize = (req: Request, returning: boolean) => async (tx: PoolClient) => {
  await authorizeNativeTerminalSessionTx(tx, req.terminal!, req.station!, 'OPERATOR');
  // ACL writers update this epoch in their transaction. Hold its shared lock
  // before resolving permissions to serialize revocation with component writes.
  if (!(await tx.query(NATIVE_TERMINAL_ACCESS_LOCK_SQL)).rows.length) {
    throw new HttpError(503, 'TERMINAL_ACCESS_UNAVAILABLE', 'Les autorisations du poste doivent être vérifiées.');
  }
  const profile = await resolveAccessProfile(req.station!.user.id);
  if (!profile || (!profile.is_superadmin && !profile.modules.some(m => m.module_key === 'production' && m.allowed))) {
    throw new HttpError(403, 'TERMINAL_SESSION_ACCESS_REVOKED', 'L’accès au poste a été révoqué.');
  }
  await assertWrite(req, returning);
  await scoped(req, tx);
};

export const preparation = asyncHandler(async (req, res) => {
  const s = await scoped(req), q = assemblyComponentPreviewSchema.parse(req.query);
  const { coverage: _coverage, ...data } = await getAssemblyComponentPreparation(s.of_id, q.quantity);
  if (data.operation?.id !== s.operation_id) throw new HttpError(403, 'TERMINAL_ASSEMBLY_SCOPE', 'Ouvrez la première opération de montage.');
  res.json({ ...data, permissions: { withdraw: await canWithdraw(req) } });
});
export const withdraw = asyncHandler(async (req, res) => {
  const s = await scoped(req), body = assemblyComponentWithdrawalSchema.parse(req.body);
  assertNativeAssemblyCommandScope(s.operation_id, body.operationId, body.idempotencyKey, commandKey.parse(req.get('Idempotency-Key')));
  await assertWrite(req, false);
  res.json(await withdrawAssemblyComponents(s.of_id, body, audit(req), authorize(req, false)));
});
export const history = asyncHandler(async (req, res) => {
  const s = await scoped(req), data = await getAssemblyComponentWithdrawals(s.of_id);
  res.json({ ...data, items: data.items.filter(item => item.operationId === s.operation_id) });
});
export const previewReturn = asyncHandler(async (req, res) => {
  const s = await scoped(req), id = z.string().uuid().parse(req.params.withdrawal_id);
  const data = await getAssemblyComponentReturn(s.of_id, id);
  if (data.operation?.id !== s.operation_id) throw new HttpError(403, 'TERMINAL_ASSEMBLY_SCOPE', 'Ce retour appartient à une autre opération.');
  res.json({ ...data, permissions: { return: await canReturnAssemblyComponents(req) } });
});
export const restore = asyncHandler(async (req, res) => {
  const s = await scoped(req), body = assemblyComponentReturnSchema.parse(req.body);
  if (body.idempotencyKey !== commandKey.parse(req.get('Idempotency-Key'))) {
    throw new HttpError(422, 'TERMINAL_ASSEMBLY_SCOPE', 'Le retour doit correspondre à la confirmation ouverte.');
  }
  await assertWrite(req, true);
  res.json(await returnAssemblyComponents(s.of_id, z.string().uuid().parse(req.params.withdrawal_id), body, audit(req), authorize(req, true)));
});
