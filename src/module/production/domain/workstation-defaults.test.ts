import {describe,it,expect} from 'vitest';
import {resolveDefaultPoste,workstationDefaultsSchema,type Workstation,type WorkstationDefaults} from './workstation-defaults';
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
const poste:Workstation={id:a,code:'CONTROLE',label:'Contrôle',machine_id:null,is_active:true,archived_at:null};
const defaults:WorkstationDefaults={postes:{},programmer_user_ids:[]};
describe('postes habituels réutilisables',()=>{
 it('reprend un poste existant par son code canonique sans créer de doublon',()=>expect(resolveDefaultPoste('CONTROLE',defaults,[poste])?.id).toBe(a));
 it('respecte le réglage explicite plutôt que le code historique',()=>expect(resolveDefaultPoste('CONTROLE',{...defaults,postes:{CONTROLE:b}},[poste,{...poste,id:b,code:'QUALITE'}])?.id).toBe(b));
 it('ne remplace pas un poste explicitement désactivé par une déduction',()=>expect(resolveDefaultPoste('CONTROLE',{...defaults,postes:{CONTROLE:null}},[poste])).toBeNull());
 it.each([{is_active:false},{archived_at:'2026-11-05'},{machine_id:b}])('écarte un poste inactif, archivé ou rattaché à une machine : %o',patch=>expect(resolveDefaultPoste('CONTROLE',defaults,[{...poste,...patch}])).toBeNull());
 it('refuse une correspondance ambiguë',()=>expect(resolveDefaultPoste('CONTROLE',defaults,[poste,{...poste,id:b}])).toBeNull());
 it('refuse les doublons de programmeur et les identifiants mal formés',()=>{
  expect(workstationDefaultsSchema.safeParse({postes:{CONTROLE:'bad'},programmer_user_ids:[]}).success).toBe(false);
  expect(workstationDefaultsSchema.safeParse({postes:{},programmer_user_ids:[1,1]}).success).toBe(false);
 });
});
