import type { Request } from 'express';
import { resolveAccessProfile } from '../../access-control/services/access-control.service';
import { roleHasStockCapability } from './stock-rbac';
import { roleHasCommandeFournisseurCapability } from '../../commande-fournisseur/domain/commande-fournisseur-rbac';
import { roleHasOfCapability } from '../../production/domain/of-rbac';
import { runWithAccountModuleAccessScope } from '../../access-control/context/account-module-access.context';

/** A grant for the current route must not expose another module's prices or
 * writes when that module has explicitly been denied on the account. */
export async function consumableAccountRights(req:Request){
  const profile=await resolveAccessProfile(req.user!.id);
  let legacy!: {reserve:boolean;purchase:boolean;prices:boolean;quality:boolean;withdraw:boolean;configure:boolean;deplete:boolean;overReceipt:boolean};
  // Deep legacy policies accept the current module grant. A Production route
  // must not lend that grant to Stock, Quality or supplier price access.
  runWithAccountModuleAccessScope(()=>{
    const reserve=roleHasStockCapability(req.user?.role,'reservation_manage');
    const deplete=roleHasStockCapability(req.user?.role,'movement_create')&&roleHasStockCapability(req.user?.role,'movement_post');
    legacy={reserve,deplete,withdraw:reserve&&deplete,
      purchase:roleHasCommandeFournisseurCapability(req.user?.role,'create'),
      prices:roleHasCommandeFournisseurCapability(req.user?.role,'prices'),
      quality:roleHasStockCapability(req.user?.role,'documents_manage'),
      configure:roleHasOfCapability(req.user?.role,'edit_prelaunch'),
      overReceipt:roleHasCommandeFournisseurCapability(req.user?.role,'over_receipt')};
  });
  const allowed=(module:string,legacy:boolean)=>profile?profile.is_superadmin||profile.modules.some(m=>m.module_key===module&&m.allowed):legacy;
  const stock=allowed('stock',legacy.reserve);
  const purchase=allowed('commandes-fournisseurs',legacy.purchase);
  const quality=allowed('qualite',legacy.quality);
  return {
    reserve:stock,purchase,prices:allowed('commandes-fournisseurs',legacy.prices),
    withdraw:allowed('stock',legacy.withdraw),
    configure:allowed('production',legacy.configure),
    deplete:allowed('stock',legacy.deplete),
    receive:quality&&allowed('stock',legacy.deplete),
    documents:quality,
    overReceipt:quality&&allowed('commandes-fournisseurs',legacy.overReceipt),
  };
}
