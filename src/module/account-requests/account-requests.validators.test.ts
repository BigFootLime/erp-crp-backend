import { describe, expect, it } from 'vitest';
import { accountRequestStatusSchema, submitAccountRequestSchema, usernameBaseFromGivenName } from './validators/account-requests.validators';

describe('account-request authority input', () => {
  it('derives an immutable ASCII username base from accented given names', () => {
    expect(usernameBaseFromGivenName('Émilie')).toBe('EMILIE');
    expect(usernameBaseFromGivenName('Léa')).toBe('LEA');
    expect(usernameBaseFromGivenName('Än-na')).toBe('AN-NA');
    expect(usernameBaseFromGivenName('Lu')).toBe('LU');
    expect(usernameBaseFromGivenName('Alix')).toBe('ALIX');
  });

  it('keeps receipt tracking opaque and validates the public password before authority work', () => {
    expect(accountRequestStatusSchema.safeParse({ headers: { receipt: 'a'.repeat(43) } }).success).toBe(true);
    expect(accountRequestStatusSchema.safeParse({ headers: { receipt: 'a'.repeat(42) } }).success).toBe(false);
    expect(submitAccountRequestSchema.safeParse({ body: { name: 'DUPONT', surname: 'Émilie', email: 'emilie@example.test', password: 'weak', avatar_key: 'avatar-1' } }).success).toBe(false);
  });
});
