import { expect,it,vi } from 'vitest';
import type { Request } from 'express';
const state=vi.hoisted(()=>({profile:vi.fn()}));
vi.mock('../../access-control/services/access-control.service',()=>({resolveAccessProfile:state.profile}));
import { consumableAccountRights } from './consumable-access';
import { runWithAccountModuleAccess } from '../../access-control/context/account-module-access.context';
it('a production grant does not override denied stock or purchase rights',async()=>{
  state.profile.mockResolvedValue({is_superadmin:false,modules:[{module_key:'production',allowed:true},{module_key:'stock',allowed:false},{module_key:'commandes-fournisseurs',allowed:false},{module_key:'qualite',allowed:true}]});
  const rights=await new Promise(resolve=>runWithAccountModuleAccess({userId:1,moduleKey:'production'},()=>{void consumableAccountRights({user:{id:1,role:'Admin'}} as Request).then(resolve);}));
  expect(rights).toMatchObject({configure:true,reserve:false,purchase:false,prices:false,withdraw:false,receive:false,deplete:false});
});
it('permits the same stock and purchase modules as the web account',async()=>{
  state.profile.mockResolvedValue({is_superadmin:false,modules:['production','stock','commandes-fournisseurs','qualite'].map(module_key=>({module_key,allowed:true}))});
  expect(await consumableAccountRights({user:{id:1,role:'Magasin'}} as Request)).toMatchObject({purchase:true,reserve:true,withdraw:true,receive:true,prices:true});
});
