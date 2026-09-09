import type { Request } from 'express';
import pool from '../../../config/database';
import { asyncHandler } from '../../../utils/asyncHandler';
import { HttpError } from '../../../utils/httpError';
import { resolveAccessProfile } from '../../access-control/services/access-control.service';
import { terminalModule,pinFingerprint,type TerminalKind } from '../domain/terminal-policy';
import { ownPinSchema } from '../validators/terminals.validators';
import { setPin,transaction } from '../repository/terminal-auth.repository';

async function ownSites(req:Request){
  const profile=await resolveAccessProfile(req.user!.id);
  if(!profile)throw new HttpError(403,'TERMINAL_MODULE_FORBIDDEN','Les droits du compte ne sont pas disponibles.');
  const kinds=(Object.keys(terminalModule) as TerminalKind[]).filter(k=>profile.is_superadmin||profile.modules.some(m=>m.module_key===terminalModule[k]&&m.allowed));
  return (await pool.query<{site_code:string;configured:boolean;changed_at:string|null}>(`
    SELECT DISTINCT t.site_code,(p.id IS NOT NULL) AS configured,p.created_at::text AS changed_at
    FROM public.cerp_terminals t LEFT JOIN public.cerp_terminal_pins p ON p.site_code=t.site_code AND p.user_id=$1 AND p.revoked_at IS NULL
    WHERE t.revoked_at IS NULL AND t.kind=ANY($2::text[]) ORDER BY t.site_code`,[req.user!.id,kinds])).rows;
}
export const getOwnPin=asyncHandler(async(req,res)=>{
  res.json({sites:await ownSites(req),available:(process.env.TERMINAL_PIN_PEPPER?.length??0)>=32});
});
export const changeOwnPin=asyncHandler(async(req,res)=>{
  const body=ownPinSchema.parse(req.body);
  if(!(await ownSites(req)).some(s=>s.site_code===body.site_code))throw new HttpError(403,'TERMINAL_SITE_FORBIDDEN','Ce site ne propose aucun terminal autorisé pour votre compte.');
  const permitted=await transaction(async tx=>{
    const bucket=`pin-change:${req.user!.id}`;
    await tx.query('INSERT INTO public.cerp_terminal_rate_limits(bucket) VALUES($1) ON CONFLICT DO NOTHING',[bucket]);
    await tx.query('SELECT bucket FROM public.cerp_terminal_rate_limits WHERE bucket=$1 FOR UPDATE',[bucket]);
    await tx.query("UPDATE public.cerp_terminal_rate_limits SET attempts=0,window_start=now(),locked_until=NULL WHERE bucket=$1 AND window_start<now()-interval '5 minutes'",[bucket]);
    const row=(await tx.query<{attempts:number}>('SELECT attempts FROM public.cerp_terminal_rate_limits WHERE bucket=$1',[bucket])).rows[0];
    if(row.attempts>=10)return false;
    await tx.query('UPDATE public.cerp_terminal_rate_limits SET attempts=attempts+1 WHERE bucket=$1',[bucket]);return true;
  });
  if(!permitted)throw new HttpError(429,'TERMINAL_PIN_CHANGE_LIMIT','Patientez cinq minutes avant de changer à nouveau votre code.');
  await setPin(body.site_code,req.user!.id,pinFingerprint(body.site_code,body.pin),req.user!.id);
  res.json({saved:true});
});
