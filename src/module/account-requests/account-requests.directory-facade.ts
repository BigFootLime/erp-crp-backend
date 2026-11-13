import type { Request } from 'express';
import type { Pool } from 'pg';
import { HttpError } from '../../utils/httpError';
import { sharedDirectoryClient, projectDirectoryProfile } from '../../shared-directory/site-runtime';
import { directoryProfileSchema } from '../../shared-directory/model';
import { withTransaction, repoListCatalogModules, repoUpsertUserModuleAccess } from '../access-control/repository/access-control.repository';
import { repoGrantSensitiveCapabilities } from '../access-control/repository/sensitive-capabilities.repository';
import type { SensitiveCapability } from '../access-control/domain/sensitive-capabilities';
import { repoInsertAuditLog } from '../audit-logs/repository/audit-logs.repository';

const BUSINESS_ADMIN_BASE_CAPABILITIES: readonly SensitiveCapability[] = ['audit.read'];
const BUSINESS_ADMIN_FACTURATION_CAPABILITIES: readonly SensitiveCapability[] = [
  'finance.validate',
  'finance.issue',
  'finance.settings_manage',
];

function directory() {
  const client = sharedDirectoryClient();
  if (!client) throw new HttpError(503, 'DIRECTORY_UNAVAILABLE', 'L’annuaire est momentanément indisponible.');
  return client;
}

type DirectoryCallFailure = {
  status?: unknown;
  code?: unknown;
};

const DIRECTORY_ACCOUNT_REQUEST_ERRORS = new Map<string, {
  status: number;
  message: string;
}>([
  ['404:ACCOUNT_REQUEST_NOT_FOUND', { status: 404, message: 'Demande introuvable.' }],
  ['409:ACCOUNT_REQUEST_IDEMPOTENCY_CONFLICT', { status: 409, message: 'Cette clé d’idempotence a déjà été utilisée avec une autre décision.' }],
  ['409:ACCOUNT_REQUEST_DECISION_CONFLICT', { status: 409, message: 'La demande a déjà reçu une décision différente.' }],
  ['409:ACCOUNT_REQUEST_VERSION_CONFLICT', { status: 409, message: 'La demande a été modifiée.' }],
  ['409:ACCOUNT_REQUEST_EMAIL_CONFLICT', { status: 409, message: 'Cette adresse ne peut plus être approuvée.' }],
  ['409:ACCOUNT_REQUEST_PROJECTION_CONFLICT', { status: 409, message: 'La projection doit être reprise avant activation.' }],
  ['409:ACCOUNT_REQUEST_MEMBERSHIP_CONFLICT', { status: 409, message: 'L’adhésion ne peut pas être activée.' }],
  ['409:ACCOUNT_REQUEST_COMPANY_MEMBERSHIP_CONFLICT', { status: 409, message: 'Le rattachement entreprise a changé. Rechargez la validation.' }],
  ['409:BUSINESS_COMPANY_MEMBERSHIP_VERSION_CONFLICT', { status: 409, message: 'Cette configuration a changé. Rechargez-la avant de réessayer.' }],
  ['409:ACCOUNT_REQUEST_DELETE_CONFLICT', { status: 409, message: 'Seule une demande terminale peut être supprimée.' }],
  ['422:ACCOUNT_REQUEST_MODULE_REQUIRED', { status: 422, message: 'Sélectionnez au moins un module.' }],
  ['422:ACCOUNT_REQUEST_COMPANY_UNAVAILABLE', { status: 422, message: 'Cette entreprise n’est pas disponible.' }],
  ['422:HISTORICAL_LINK_REQUIRES_OWNER_OPERATION', { status: 422, message: 'Le rattachement historique exige une opération administrateur distincte.' }],
  ['428:MFA_STEP_UP_REQUIRED', { status: 428, message: 'Confirmez votre double authentification pour cette opération.' }],
  ['401:DIRECTORY_SESSION_REQUIRED', { status: 401, message: 'Une nouvelle connexion est requise.' }],
  ['401:DIRECTORY_SESSION_REJECTED', { status: 401, message: 'Une nouvelle connexion est requise.' }],
  ['401:DIRECTORY_SESSION_STALE', { status: 401, message: 'Une nouvelle connexion est requise.' }],
  ['401:DIRECTORY_LOCAL_SESSION_STALE', { status: 401, message: 'Une nouvelle connexion est requise.' }],
  ['403:DIRECTORY_ADMIN_REQUIRED', { status: 403, message: 'Accès administrateur requis.' }],
  ['403:DIRECTORY_OWNER_REQUIRED', { status: 403, message: 'Cette modification commune exige un administrateur de Production.' }],
  ['403:ACCOUNT_REQUEST_PRODUCTION_ONLY', { status: 403, message: 'Cette opération est réservée à la Production.' }],
  ['404:BUSINESS_COMPANY_PROFILE_NOT_FOUND', { status: 404, message: 'Profil introuvable.' }],
]);

export function mapDirectoryAccountRequestError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const failure = error as DirectoryCallFailure | null;
  const status = typeof failure?.status === 'number' ? failure.status : null;
  const code = typeof failure?.code === 'string' ? failure.code : null;
  const mapped = status !== null && code !== null
    ? DIRECTORY_ACCOUNT_REQUEST_ERRORS.get(`${status}:${code}`)
    : undefined;
  if (mapped) return new HttpError(mapped.status, code!, mapped.message);
  // A malformed signature, a transport failure, or an operation unknown to a
  // mismatched Directory must never become an authentication failure or leak
  // the authority response to the public/site boundary.
  return new HttpError(503, 'DIRECTORY_UNAVAILABLE', 'L’annuaire est momentanément indisponible.');
}

async function callDirectoryAccountRequest<T>(operation: string, payload: unknown): Promise<T> {
  try {
    return await directory().call<T>(operation, payload);
  } catch (error) {
    throw mapDirectoryAccountRequestError(error);
  }
}

function session(req: Request) {
  if (!req.user?.directory_session) throw new HttpError(401, 'DIRECTORY_SESSION_REQUIRED', 'Une nouvelle connexion est requise.');
  return req.user.directory_session;
}
export async function submitDirectoryRequest(input: { name: string; surname: string; email: string; password: string; avatar_key: string }) {
  return callDirectoryAccountRequest('account-request-submit', { input });
}
export async function readDirectoryRequestStatus(receipt: string) {
  return callDirectoryAccountRequest('account-request-status', { input: { receipt } });
}
export async function listDirectoryRequests(req: Request, input: unknown) {
  return callDirectoryAccountRequest('account-request-list', { directory_session: session(req), input });
}
export async function listDirectoryRequestCompanyAccessOptions(req: Request, requestId: string) {
  return callDirectoryAccountRequest('account-request-company-access-options', {
    directory_session: session(req), input: { request_id: requestId },
  });
}
function sensitiveCapabilitiesForApproval(
  administrativeKind: unknown,
  selected: readonly string[],
): readonly SensitiveCapability[] {
  if (administrativeKind !== 'BUSINESS_ADMIN') return [];
  return selected.includes('facturation')
    ? [...BUSINESS_ADMIN_BASE_CAPABILITIES, ...BUSINESS_ADMIN_FACTURATION_CAPABILITIES]
    : BUSINESS_ADMIN_BASE_CAPABILITIES;
}

async function applyClosedModuleSelection(
  localUserId: number,
  selected: string[],
  actorUserId: number,
  administrativeKind: unknown,
) {
  await withTransaction(async tx => {
    const modules = await repoListCatalogModules(tx);
    const selectable = new Set(modules.filter(module => module.is_active && !module.is_protected).map(module => module.module_key));
    for (const key of selected) if (!selectable.has(key)) throw new HttpError(422, 'ACCOUNT_REQUEST_MODULE_INVALID', 'Un module sélectionné est indisponible.');
    for (const key of selectable) await repoUpsertUserModuleAccess(tx, { userId: localUserId, moduleKey: key, access: selected.includes(key) ? 'GRANTED' : 'DENIED', updatedBy: actorUserId });
    const capabilities = sensitiveCapabilitiesForApproval(administrativeKind, selected);
    await repoGrantSensitiveCapabilities(tx, {
      userId: localUserId,
      capabilities,
      updatedBy: actorUserId,
    });
    await repoInsertAuditLog({
      user_id: actorUserId,
      tx,
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      body: {
        event_type: 'ACTION',
        action: 'ACCOUNT_REQUEST_SENSITIVE_CAPABILITIES_APPLIED',
        page_key: 'administration',
        entity_type: 'user',
        entity_id: String(localUserId),
        path: '/admin/account-requests',
        details: {
          granted_capabilities: capabilities,
          source: 'account_request_approval',
        },
      },
    });
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
  const prepared = await callDirectoryAccountRequest<Record<string, unknown>>('account-request-approve', { directory_session: session(req), input });
  // The Directory transaction returns the current terminal state for an
  // idempotent replay. Do not project it or replay its historical module
  // selection: an owner may have changed the account's access after approval.
  if (prepared.status === 'APPROVED') return prepared;
  const profile = directoryProfileSchema.parse(prepared.profile);
  const approvedModules = Array.isArray(prepared.module_keys) ? prepared.module_keys.map(value => String(value)) : [];
  const projection = await projectDirectoryProfile(db, profile);
  await applyClosedModuleSelection(
    projection.id,
    approvedModules,
    req.user!.id,
    input.approval.administrative_kind,
  );
  return callDirectoryAccountRequest('account-request-activate', { directory_session: session(req), input: { id: prepared.request_id, expected_version: prepared.version, profile_id: profile.profile_id } });
}
export async function rejectDirectoryRequest(req: Request, input: unknown) {
  return callDirectoryAccountRequest('account-request-reject', { directory_session: session(req), input });
}
export async function deleteDirectoryRequest(req: Request, input: unknown) {
  return callDirectoryAccountRequest('account-request-delete', { directory_session: session(req), input });
}
