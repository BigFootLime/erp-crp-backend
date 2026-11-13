import { describe, expect, it } from 'vitest';
import { HttpError } from '../../utils/httpError';
import { mapDirectoryAccountRequestError } from './account-requests.directory-facade';

describe('Directory account-request error boundary', () => {
  it('maps a missing opaque receipt to the public 404 contract', () => {
    const error = mapDirectoryAccountRequestError(Object.assign(new Error('raw authority detail'), {
      status: 404,
      code: 'ACCOUNT_REQUEST_NOT_FOUND',
    }));
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 404, code: 'ACCOUNT_REQUEST_NOT_FOUND', message: 'Demande introuvable.' });
  });

  it.each([
    [409, 'ACCOUNT_REQUEST_VERSION_CONFLICT', 409],
    [409, 'BUSINESS_COMPANY_MEMBERSHIP_VERSION_CONFLICT', 409],
    [422, 'ACCOUNT_REQUEST_COMPANY_UNAVAILABLE', 422],
    [428, 'MFA_STEP_UP_REQUIRED', 428],
  ])('preserves the allowlisted %s/%s business contract', (status, code, expectedStatus) => {
    const error = mapDirectoryAccountRequestError(Object.assign(new Error('private authority detail'), { status, code }));
    expect(error).toMatchObject({ status: expectedStatus, code });
    expect(error.message).not.toContain('private authority detail');
  });

  it('fails closed for unknown or transport-shaped authority errors', () => {
    const error = mapDirectoryAccountRequestError(Object.assign(new Error('signature mismatch'), {
      status: 401,
      code: 'DIRECTORY_SIGNATURE_INVALID',
    }));
    expect(error).toMatchObject({ status: 503, code: 'DIRECTORY_UNAVAILABLE', message: 'L’annuaire est momentanément indisponible.' });
  });
});
