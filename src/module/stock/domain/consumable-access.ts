import type { Request } from 'express';
import { resolveAccessProfile } from '../../access-control/services/access-control.service';
import { roleHasStockCapability } from './stock-rbac';
import { roleHasCommandeFournisseurCapability } from '../../commande-fournisseur/domain/commande-fournisseur-rbac';
import { roleHasOfCapability } from '../../production/domain/of-rbac';

/** A grant for the current route must not expose another module's prices or
 * writes when that module has explicitly been denied on the account. */
export async function consumableAccountRights(req:Request){
  const profile=await resolveAccessProfile(req.user!.id);
  const allowed=(module:string,legacy:boolean)=>profile?profile.is_superadmin||profile.modules.some(m=>m.module_key===module&&m.allowed):legacy;
  const stock=allowed('stock',roleHasStockCapability(req.user?.role,'reservation_manage'));
  const purchase=allowed('commandes-fournisseurs',roleHasCommandeFournisseurCapability(req.user?.role,'create'));
  const quality=allowed('qualite',roleHasStockCapability(req.user?.role,'documents_manage'));
  return {
    reserve:stock,purchase,prices:allowed('commandes-fournisseurs',roleHasCommandeFournisseurCapability(req.user?.role,'prices')),
    withdraw:allowed('stock',roleHasStockCapability(req.user?.role,'reservation_manage')&&roleHasStockCapability(req.user?.role,'movement_create')&&roleHasStockCapability(req.user?.role,'movement_post')),
    configure:allowed('production',roleHasOfCapability(req.user?.role,'edit_prelaunch')),
    deplete:allowed('stock',roleHasStockCapability(req.user?.role,'movement_create')&&roleHasStockCapability(req.user?.role,'movement_post')),
    receive:quality&&allowed('stock',roleHasStockCapability(req.user?.role,'movement_create')&&roleHasStockCapability(req.user?.role,'movement_post')),
    documents:quality,
    overReceipt:quality&&roleHasCommandeFournisseurCapability(req.user?.role,'over_receipt'),
  };
}
