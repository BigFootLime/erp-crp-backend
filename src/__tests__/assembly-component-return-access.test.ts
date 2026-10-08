import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock('../module/access-control/services/access-control.service', () => ({ resolveAccessProfile: mocks.profile }));
import { canReturnAssemblyComponents } from '../module/production/domain/assembly-component-access';
import { runWithAccountModuleAccess, getAccountModuleAccessContext } from '../module/access-control/context/account-module-access.context';
import { assemblyComponentReturnSchema } from '../module/production/validators/assembly-component-consumption.validators';

const request = (role: string) => ({ user: { id: 1, role } }) as Request;
const body = { idempotencyKey: '00000000-0000-4000-8000-000000000001', expectedVersion: 'proof-v1',
  reason: 'Erreur de quantité au montage', confirmPhysicalReturn: true };

describe('unused assembly intake return — final acceptance preparation', () => {
  beforeEach(() => { mocks.profile.mockReset(); mocks.profile.mockResolvedValue(null); });
  it('does not turn a production module grant into legacy stock correction rights', async () => {
    const result = await new Promise<boolean>((resolve, reject) => {
      runWithAccountModuleAccess({ userId: 1, moduleKey: 'production' }, () => {
        canReturnAssemblyComponents(request('atelier')).then(value => {
          expect(getAccountModuleAccessContext()?.moduleKey).toBe('production'); resolve(value);
        }).catch(reject);
      });
    });
    expect(result).toBe(false);
    expect(await canReturnAssemblyComponents(request('stock'))).toBe(true);
  });
  it('respects an explicit stock denial even for a legacy administrator', async () => {
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [{ module_key: 'production', allowed: true }, { module_key: 'stock', allowed: false }] });
    expect(await canReturnAssemblyComponents(request('administrateur'))).toBe(false);
  });
  it('accepts the account stock grant or superadmin', async () => {
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [{ module_key: 'stock', allowed: true }] });
    expect(await canReturnAssemblyComponents(request('atelier'))).toBe(true);
    mocks.profile.mockResolvedValue({ is_superadmin: true, modules: [] });
    expect(await canReturnAssemblyComponents(request('administrateur'))).toBe(true);
  });
  it('requires physical confirmation and forbids client-supplied stock quantities or lots', () => {
    expect(assemblyComponentReturnSchema.safeParse(body).success).toBe(true);
    expect(assemblyComponentReturnSchema.safeParse({ ...body, confirmPhysicalReturn: false }).success).toBe(false);
    expect(assemblyComponentReturnSchema.safeParse({ ...body, quantity: 100 }).success).toBe(false);
    expect(assemblyComponentReturnSchema.safeParse({ ...body, lotId: body.idempotencyKey }).success).toBe(false);
    expect(assemblyComponentReturnSchema.safeParse({ ...body, reason: ' ' }).success).toBe(false);
  });
});
