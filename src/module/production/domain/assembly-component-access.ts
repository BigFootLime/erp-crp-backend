import type { Request } from 'express';
import { resolveAccessProfile } from '../../access-control/services/access-control.service';
import { roleHasStockCapability } from '../../stock/domain/stock-rbac';
import { runWithAccountModuleAccessScope } from '../../access-control/context/account-module-access.context';

export async function canReturnAssemblyComponents(req: Request) {
  const profile = await resolveAccessProfile(req.user!.id);
  if (profile) return profile.is_superadmin || profile.modules.some(module => module.module_key === 'stock' && module.allowed);
  // A production grant cannot stand in for legacy stock correction rights.
  let allowed = false;
  runWithAccountModuleAccessScope(() => {
    allowed = roleHasStockCapability(req.user?.role, 'movement_compensate')
      && roleHasStockCapability(req.user?.role, 'reservation_manage')
      && roleHasStockCapability(req.user?.role, 'movement_create')
      && roleHasStockCapability(req.user?.role, 'movement_post');
  });
  return allowed;
}
