export const NATIVE_TERMINAL_ACCOUNT_SQL = `SELECT id FROM public.users
  WHERE id=$1 AND status='Active' AND NOT mfa_reenrollment_required FOR SHARE`;
export const NATIVE_TERMINAL_DEVICE_SQL = `SELECT status,machine_id,auto_lock_seconds FROM public.production_devices
  WHERE id=$1::uuid FOR SHARE`;
export const NATIVE_TERMINAL_SESSION_SQL = `SELECT ts.account_epoch::text,u.role FROM public.cerp_terminals t
  JOIN public.cerp_terminal_sessions ts ON ts.terminal_id=t.id
  JOIN public.operator_device_sessions s ON s.id=ts.session_id AND s.device_id=t.device_id
  JOIN public.cerp_terminal_pins p ON p.id=ts.pin_id AND p.user_id=s.user_id
  JOIN public.users u ON u.id=s.user_id
  WHERE t.id=$1::uuid AND t.device_id=$2::uuid AND t.kind::text=$7 AND t.revoked_at IS NULL
    AND t.site_code=$4 AND p.site_code=t.site_code AND p.revoked_at IS NULL
    AND s.id=$3::uuid AND s.user_id=$5 AND s.machine_id IS NOT DISTINCT FROM $8::uuid
    AND s.state='ACTIVE' AND s.expires_at>clock_timestamp()
    AND ts.last_input_at>clock_timestamp()-make_interval(secs=>$6)
    AND u.status='Active' AND NOT u.mfa_reenrollment_required FOR SHARE OF t,ts,s,p`;
export const NATIVE_TERMINAL_EPOCH_SQL = `SELECT session_epoch::text FROM public.realtime_session_epochs
  WHERE user_id=$1 FOR SHARE`;
export const NATIVE_TERMINAL_ACCESS_LOCK_SQL = `SELECT epoch FROM public.realtime_authorization_epoch
  WHERE singleton=true FOR SHARE`;
