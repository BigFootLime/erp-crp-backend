import {z} from 'zod';
import {workProfileSchema} from '../module/auth/validators/work-profile.validator';
export const directoryIdSchema=z.string().uuid();
export const directoryDatabaseSchema=z.string().regex(/^cerp_directory_[a-f0-9]{32}$/);
export const siteIdSchema=z.string().refine(v=>v==='cerp_prod'||v==='cerp_test'||/^cerp_test_[a-f0-9]{32}$/.test(v));
export const privateOwnerSeedSchema=z.object({
 version:z.literal(1),command_id:z.string().uuid(),directory_mode:z.literal('EMPTY_NO_LEGACY_IMPORT'),
 profile:z.object({username:z.string().min(3).max(50),name:z.string().min(1).max(80),surname:z.string().min(1).max(80),email:z.string().email(),weekly_hours:z.number().positive().max(80),employment_type:z.literal('CDI'),job_title:z.string().min(1).max(80),avatar_key:z.null(),personal_avatar:z.null()}).strict(),
 authorization:z.object({is_superadmin:z.literal(true),role_key:z.literal('Administrateur Systeme et Reseau')}).strict(),
 authentication:z.object({password_hash:z.string().regex(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/),mfa_required:z.literal(true),mfa_reenrollment_required:z.literal(true)}).strict(),
 work_profile_incomplete:z.literal(true),
}).strict();
export const directoryProfileSchema=z.object({
 profile_id:z.string().uuid(),source_user_id:z.number().int().positive(),database:siteIdSchema,
 username:z.string(),name:z.string(),surname:z.string(),email:z.string().nullable(),avatar_key:z.string().nullable(),avatar_asset_id:z.string().uuid().nullable(),
 role:z.string(),roles:z.array(z.string()),is_superadmin:z.boolean(),status:z.enum(['Active','Inactive','Blocked','Suspended']),
 job_title:z.string().nullable(),employment_type:z.string().nullable(),weekly_hours_target:z.number().nullable(),work_profile_incomplete:z.boolean(),
 mfa_reenrollment_required:z.boolean(),
 work_profile:workProfileSchema.nullable().default(null),work_profile_start_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
}).strict();
export type DirectoryProfile=z.infer<typeof directoryProfileSchema>;
export const directorySessionSchema=directoryProfileSchema.extend({
 status:z.literal('Active'),
 global_session_epoch:z.number().int().nonnegative(),membership_version:z.number().int().nonnegative(),
 mfa_factor_id:z.string().uuid(),mfa_factor_version:z.number().int().positive(),mfa_verified_at:z.string().datetime(),mfa_method:z.enum(['totp','recovery_code']),
}).strict();
export type DirectorySession=z.infer<typeof directorySessionSchema>;
