import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock('../module/access-control/services/access-control.service', () => ({ resolveAccessProfile: mocks.profile }));
import { consumableAccountRights } from '../module/stock/domain/consumable-access';
import { runWithAccountModuleAccess, getAccountModuleAccessContext } from '../module/access-control/context/account-module-access.context';

const request = (role: string) => ({ user: { id: 1, role } }) as Request;
describe('cross-module consumable rights — final acceptance preparation', () => {
  beforeEach(() => { mocks.profile.mockReset(); mocks.profile.mockResolvedValue(null); });
  it('does not borrow the current Production grant when the account profile is missing', async () => {
    await new Promise<void>((resolve, reject) => {
      runWithAccountModuleAccess({ userId: 1, moduleKey: 'production' }, () => {
        consumableAccountRights(request('atelier')).then(rights => {
          expect(rights.prices).toBe(false); expect(rights.purchase).toBe(false);
          expect(rights.reserve).toBe(false); expect(rights.withdraw).toBe(false);
          expect(rights.overReceipt).toBe(false);
          expect(getAccountModuleAccessContext()?.moduleKey).toBe('production'); resolve();
        }).catch(reject);
      });
    });
  });
  it('preserves the legacy administrator rights without any account grant', async () => {
    const rights = await consumableAccountRights(request('administrateur'));
    expect(rights).toMatchObject({ prices: true, purchase: true, reserve: true, withdraw: true, overReceipt: true });
  });
  it('respects explicit Stock and supplier denials even for a legacy administrator', async () => {
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [{ module_key: 'production', allowed: true },
      { module_key: 'qualite', allowed: true }, { module_key: 'stock', allowed: false }, { module_key: 'commandes-fournisseurs', allowed: false }] });
    expect(await consumableAccountRights(request('administrateur'))).toMatchObject({ configure: true, documents: true,
      prices: false, purchase: false, reserve: false, withdraw: false, receive: false, overReceipt: false });
  });
  it('requires supplier access for over-receipt but preserves ordinary quality/stock receipt', async () => {
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [{ module_key: 'qualite', allowed: true },
      { module_key: 'stock', allowed: true }, { module_key: 'commandes-fournisseurs', allowed: false }] });
    expect(await consumableAccountRights(request('administrateur'))).toMatchObject({ receive: true, overReceipt: false, prices: false });
  });
  it('preserves authoritative module grants and superadmin', async () => {
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [{ module_key: 'production', allowed: true },
      { module_key: 'qualite', allowed: true }, { module_key: 'stock', allowed: true }, { module_key: 'commandes-fournisseurs', allowed: true }] });
    expect(await consumableAccountRights(request('atelier'))).toMatchObject({ receive: true, withdraw: true, prices: true });
    mocks.profile.mockResolvedValue({ is_superadmin: true, modules: [] });
    expect(await consumableAccountRights(request('administrateur'))).toMatchObject({ receive: true, withdraw: true, prices: true, overReceipt: true });
  });
});
