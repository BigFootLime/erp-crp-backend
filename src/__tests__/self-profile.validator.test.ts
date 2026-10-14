import {describe,it,expect} from 'vitest';
import {selfProfilePatchSchema} from '../module/auth/validators/self-profile.validator';
describe('own profile boundary',()=>{
 it('normalizes identity and contact fields without mutating opaque authentication data',()=>{
  expect(selfProfilePatchSchema.parse({name:'  marTin  du  pont ',surname:' éLiSe ',email:' ELISE@EXAMPLE.INVALID ',tel_no:'+33 6 12 34 56 78'})).toEqual({name:'MARTIN DU PONT',surname:'ÉLISE',email:'elise@example.invalid',tel_no:'+33612345678'});
 });
 it.each(['id','user_id','profile_id','username','role','roles','status','is_superadmin','password','mfa_reenrollment_required','weekly_hours_target','employment_type'])('rejects administrative or target field %s',field=>{expect(selfProfilePatchSchema.safeParse({name:'MARTIN',[field]:'forbidden'}).success).toBe(false);});
 it('allows clearing contact and selecting a shipped avatar only',()=>{expect(selfProfilePatchSchema.parse({tel_no:'',avatar_key:'programmer'})).toEqual({tel_no:null,avatar_key:'programmer'});expect(selfProfilePatchSchema.safeParse({avatar_key:'https://external.invalid/x.png'}).success).toBe(false);});
 it.each([{}, {name:' '},{email:'not-email'},{tel_no:'abc'},{avatar_key:null}])('rejects empty or invalid changes %j',input=>{expect(selfProfilePatchSchema.safeParse(input).success).toBe(false);});
});
