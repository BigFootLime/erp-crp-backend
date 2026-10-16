import type { Request } from 'express';
import type { Pool } from 'pg';
import { HttpError } from '../../utils/httpError';
import { sharedDirectoryClient, projectDirectoryProfile } from '../../shared-directory/site-runtime';
import { directoryProfileSchema } from '../../shared-directory/model';
import { withTransaction, repoListCatalogModules, repoUpsertUserModuleAccess } from '../access-control/repository/access-control.repository';

function directory() {
  const client = sharedDirectoryClient();
  if (!client) throw new HttpError(503, 'DIRECTORY_UNAVAILABLE', 'L’annuaire est momentanément indisponible.');
  return client;
}
function session(req: Request) {
  if (!req.user?.directory_session) throw new HttpError(401, 'DIRECTORY_SESSION_REQUIRED', 'Une nouvelle connexion est requise.');
  return req.user.directory_session;
}
export async function submitDirectoryRequest(input: { name: string; surname: string; email: string; password: string; avatar_key: string }) {
  return directory().call('account-request-submit', { input });
}
export async function readDirectoryRequestStatus(receipt: string) {
  return directory().call('account-request-status', { input: { receipt } });
}
export async function listDirectoryRequests(req: Request, input: unknown) {
  return directory().call('account-request-list', { directory_session: session(req), input });
}
async function applyClosedModuleSelection(localUserId: number, selected: string[], actorUserId: number) {
  await withTransaction(async tx => {
    const modules = await repoListCatalogModules(tx);
    const selectable = new Set(modules.filter(module => module.is_active && !module.is_protected).map(module => module.module_key));
    for (const key of selected) if (!selectable.has(key)) throw new HttpError(422, 'ACCOUNT_REQUEST_MODULE_INVALID', 'Un module sélectionné est indisponible.');
    for (const key of selectable) await repoUpsertUserModuleAccess(tx, { userId: localUserId, moduleKey: key, access: selected.includes(key) ? 'GRANTED' : 'DENIED', updatedBy: actorUserId });
  });
}
async function assertSelectableModules(selected: string[]) {
  await withTransaction(async tx => {
    const selectable = new Set((await repoListCatalogModules(tx)).filter(module => module.is_active && !module.is_protected).map(module => module.module_key));
    for (const key of selected) if (!selectable.has(key)) throw new HttpError(422, 'ACCOUNT_REQUEST_MODULE_INVALID', 'Un module sélectionné est indisponible.');
  });
}
export async function approveDirectoryRequest(db: Pool, req: Request, input: { id: string; approval: Record<string, unknown>; key: string }) {
  const selected = Array.isArray(input.approval.module_keys) ? input.approval.module_keys.map(value => String(value)) : [];
  await assertSelectableModules(selected);
  const prepared = await directory().call<Record<string, unknown>>('account-request-approve', { directory_session: session(req), input });
  // The Directory transaction returns the current terminal state for an
  // idempotent replay. Do not project it or replay its historical module
  // selection: an owner may have changed the account's access after approval.
  if (prepared.status === 'APPROVED') return prepared;
  const profile = directoryProfileSchema.parse(prepared.profile);
  const approvedModules = Array.isArray(prepared.module_keys) ? prepared.module_keys.map(value => String(value)) : [];
  const projection = await projectDirectoryProfile(db, profile);
  await applyClosedModuleSelection(projection.id, approvedModules, req.user!.id);
  return directory().call('account-request-activate', { directory_session: session(req), input: { id: prepared.request_id, expected_version: prepared.version, profile_id: profile.profile_id } });
}
export async function rejectDirectoryRequest(req: Request, input: unknown) {
  return directory().call('account-request-reject', { directory_session: session(req), input });
}
export async function deleteDirectoryRequest(req: Request, input: unknown) {
  return directory().call('account-request-delete', { directory_session: session(req), input });
}
