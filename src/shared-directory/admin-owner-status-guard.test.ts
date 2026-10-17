import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ directory: vi.fn() }));
vi.mock('../config/database', () => ({ default: {} }));
vi.mock('./site-runtime', () => ({ sharedDirectoryClient: mocks.directory }));

import { lockDirectoryOwnerStatusMutation } from '../module/admin/repository/admin.repository';
import { assertDirectoryStatusMutationAllowed } from './admin.operations';

const profileId = '11111111-1111-4111-8111-111111111111';

function queryer(options: { installed?: boolean; owner?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("to_regclass('public.cerp_directory_memberships')")) return { rows: [{ installed: options.installed ?? true }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM public.cerp_directory_memberships')) return { rows: options.owner ? [{ ok: 1 }] : [] };
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

describe('directory owner status guard', () => {
  beforeEach(() => vi.resetAllMocks());

  it('refuses a Production owner status change even when the caller is using the Test site view', async () => {
    const db = queryer({ owner: true });
    await expect(assertDirectoryStatusMutationAllowed(db as never, profileId, 'Inactive')).rejects
      .toMatchObject({ status: 409, code: 'DIRECTORY_OWNER_STATUS_MANAGED' });
    expect(db.calls.some(sql => sql.includes("database_id='cerp_prod'"))).toBe(true);
  });

  it('keeps ordinary non-owner status changes available through the directory operation', async () => {
    const db = queryer({ owner: false });
    await expect(assertDirectoryStatusMutationAllowed(db as never, profileId, 'Blocked')).resolves.toBeUndefined();
  });

  it('takes the same global then membership/user lock order before a repository status write', async () => {
    mocks.directory.mockReturnValue(null);
    const tx = queryer({ installed: true, owner: false });
    await expect(lockDirectoryOwnerStatusMutation(tx as never, 42, 'Inactive')).resolves.toBeUndefined();
    expect(tx.calls[0]).toContain("to_regclass('public.cerp_directory_memberships')");
    expect(tx.calls[1]).toContain('pg_advisory_xact_lock');
    expect(tx.calls[2]).toContain('FOR UPDATE OF m,u');
  });

  it('preserves the local lifecycle path when directory tables are absent and the directory is disabled', async () => {
    mocks.directory.mockReturnValue(null);
    const tx = queryer({ installed: false });
    await expect(lockDirectoryOwnerStatusMutation(tx as never, 42, 'Inactive')).resolves.toBeUndefined();
    expect(tx.calls).toHaveLength(1);
  });

  it('fails closed when a configured directory is missing its authority tables', async () => {
    mocks.directory.mockReturnValue({ call: vi.fn() });
    const tx = queryer({ installed: false });
    await expect(lockDirectoryOwnerStatusMutation(tx as never, 42, 'Inactive')).rejects
      .toMatchObject({ status: 503, code: 'DIRECTORY_AUTHORITY_REQUIRED' });
    expect(tx.calls).toHaveLength(1);
  });
});
