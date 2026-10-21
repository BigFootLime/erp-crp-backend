import { describe, expect, it } from 'vitest';
import { ASSIGNABLE_USER_ROLES, PRIMARY_USER_ROLES } from '../auth/domain/roles';
import { accountRequestStatusSchema, approveAccountRequestSchema, submitAccountRequestSchema, usernameBaseFromGivenName } from './validators/account-requests.validators';

const approval = {
  params: { id: '13720000-0000-4000-8000-000000000001' },
  headers: { idempotencyKey: '13720000-0000-4000-8000-000000000002' },
  body: {
    expected_version: 3,
    primary_role: 'Employee',
    roles: [...ASSIGNABLE_USER_ROLES],
    administrative_kind: 'STANDARD',
    module_keys: ['stock', 'qualite', 'planning'],
  },
};

describe('account-request approval functions', () => {
  it('accepts every catalogue function together without losing roles or selected modules', () => {
    expect(approval.body.roles.length).toBeGreaterThan(20);
    expect(approveAccountRequestSchema.parse(approval)).toEqual(approval);
  });

  it.each(PRIMARY_USER_ROLES)('accepts the selected primary function %s with the full catalogue', (primaryRole) => {
    const input = { ...approval, body: { ...approval.body, primary_role: primaryRole } };
    expect(approveAccountRequestSchema.parse(input)).toEqual(input);
  });

  it('still requires the primary function to be selected', () => {
    const result = approveAccountRequestSchema.safeParse({
      ...approval,
      body: { ...approval.body, primary_role: 'Responsable Qualité', roles: ['Employee'] },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(issue => issue.path.join('.') === 'body.roles')).toBe(true);
  });

  it.each([
    { roles: [] },
    { roles: [...ASSIGNABLE_USER_ROLES.slice(1), 'Role-Inconnu'] },
    { primary_role: 'SuperAdmin' },
    { primary_role: 'Qualité' },
    { is_superadmin: true },
    { expected_version: -1 },
  ])('rejects invalid or privileged approval input: %j', (patch) => {
    expect(approveAccountRequestSchema.safeParse({ ...approval, body: { ...approval.body, ...patch } }).success).toBe(false);
  });
});

describe('account-request authority input', () => {
  it('rejects a first name that cannot produce an identifier as an input error before hashing or persistence', () => {
    const body={name:'DUPONT',surname:'💡💡',email:'fixture@example.test',password:'Fixture!StrongPassword1372',avatar_key:'robot'};
    const result=submitAccountRequestSchema.safeParse({body});
    expect(result.success).toBe(false);
    if(!result.success)expect(result.error.issues.some(issue=>issue.path.join('.')==='body.surname')).toBe(true);
    expect(submitAccountRequestSchema.safeParse({body:{...body,surname:'A'.repeat(51)}}).success).toBe(false);
    expect(submitAccountRequestSchema.safeParse({body:{...body,surname:'Li'}}).success).toBe(true);
  });

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
