import type {Client} from 'pg';
import {assertDirectoryIdentity} from './session.repository';
import {directoryIdSchema} from './model';
/** Only the privileged installer may bind the single human-authorized bootstrap owner. */
export async function approveBootstrapOwnerActor(source:Client,target:Client,directoryId:string,commandId:string){
 directoryIdSchema.parse(directoryId);directoryIdSchema.parse(commandId);await assertDirectoryIdentity(source,directoryId);
 const owner=(await source.query(`SELECT p.profile_id,u.username,u.email FROM public.cerp_directory_bootstrap_commands c
  JOIN public.cerp_directory_profiles p ON p.profile_id=c.profile_id JOIN public.users u ON u.id=p.user_id
  JOIN public.cerp_directory_memberships m ON m.profile_id=p.profile_id AND m.database_id='cerp_prod'
  WHERE c.command_id=$1::uuid AND u.status='Active' AND m.status='Active' AND m.is_superadmin`,[commandId])).rows[0];
 if(!owner)throw new Error('DIRECTORY_BOOTSTRAP_OWNER_REQUIRED');
 const site=(await target.query('SELECT current_database() AS database')).rows[0]?.database;
 if(site!=='cerp_prod'&&site!=='cerp_test')throw new Error('DIRECTORY_OWNER_BINDING_FIXED_SITE_REQUIRED');
 await target.query('BEGIN');
 try{
  const rows=(await target.query<{id:number;directory_profile_id:string|null}>('SELECT id,directory_profile_id FROM public.users WHERE upper(username)=upper($1) AND lower(email)=lower($2) FOR UPDATE',[owner.username,owner.email])).rows;
  if(rows.length===0){await target.query('COMMIT');return {site,existing_actor:false};}
  if(rows.length!==1||rows[0].directory_profile_id&&rows[0].directory_profile_id!==owner.profile_id)throw new Error('DIRECTORY_OWNER_BINDING_AMBIGUOUS');
  const existing=(await target.query('SELECT profile_id,directory_id,approved_command_id FROM public.cerp_directory_approved_actor_bindings WHERE user_id=$1',[rows[0].id])).rows[0];
  if(existing&&(existing.profile_id!==owner.profile_id||existing.directory_id!==directoryId||existing.approved_command_id!==commandId))throw new Error('DIRECTORY_OWNER_BINDING_CONFLICT');
  await target.query(`INSERT INTO public.cerp_directory_approved_actor_bindings(profile_id,user_id,directory_id,expected_username,expected_email,approved_command_id)
   VALUES($1::uuid,$2,$3::uuid,$4,$5,$6::uuid) ON CONFLICT(profile_id) DO NOTHING`,[owner.profile_id,rows[0].id,directoryId,owner.username,owner.email,commandId]);
  await target.query('COMMIT');return {site,existing_actor:true,local_actor_id:rows[0].id};
 }catch(error){await target.query('ROLLBACK');throw error;}
}
