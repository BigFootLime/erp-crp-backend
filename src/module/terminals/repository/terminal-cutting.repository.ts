import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import type { StationContext } from '../../production/middlewares/station-authorization.middleware';
import { assertCuttingTarget } from '../../production/repository/station-cutting.repository';
import type { Terminal } from './terminal-auth.repository';
/** Native PIN sessions use last_input_at, rather than the web station heartbeat. */
export async function authorizeNativeCuttingTx(tx: PoolClient, terminal: Terminal, station: StationContext, ofId: number, operationId: string) {
    const account = (await tx.query(`SELECT id FROM public.users
      WHERE id=$1 AND status='Active' AND NOT mfa_reenrollment_required FOR SHARE`, [station.user.id])).rows[0];
    if (!account) throw new HttpError(401, 'TERMINAL_ACCOUNT_REJECTED', 'Terminez la récupération du compte avant de reprendre le poste.');
    const device = (await tx.query(`SELECT status,machine_id FROM public.production_devices
    WHERE id=$1::uuid FOR SHARE`, [terminal.device_id])).rows[0];
    if (device?.status !== 'ACTIVE' || device.machine_id !== null)
        throw new HttpError(401, 'TERMINAL_DEVICE_REJECTED', 'Ce poste de découpe n’est plus autorisé.');
    const live = (await tx.query(`SELECT ts.account_epoch::text,u.role FROM public.cerp_terminals t
    JOIN public.cerp_terminal_sessions ts ON ts.terminal_id=t.id
    JOIN public.operator_device_sessions s ON s.id=ts.session_id AND s.device_id=t.device_id
    JOIN public.cerp_terminal_pins p ON p.id=ts.pin_id AND p.user_id=s.user_id
    JOIN public.users u ON u.id=s.user_id
    WHERE t.id=$1::uuid AND t.device_id=$2::uuid AND t.kind='CUTTING' AND t.revoked_at IS NULL
      AND t.site_code=$4 AND p.site_code=t.site_code AND p.revoked_at IS NULL
      AND s.id=$3::uuid AND s.user_id=$5 AND s.machine_id IS NULL
      AND s.state='ACTIVE' AND s.expires_at>clock_timestamp()
      AND ts.last_input_at>clock_timestamp()-make_interval(secs=>$6)
      AND u.status='Active' AND NOT u.mfa_reenrollment_required FOR SHARE OF t,ts,s,p`, [terminal.id, terminal.device_id, station.session_id, terminal.site_code, station.user.id, terminal.auto_lock_seconds])).rows[0];
    const epoch = live ? (await tx.query(`SELECT session_epoch::text FROM public.realtime_session_epochs
    WHERE user_id=$1 FOR SHARE`, [station.user.id])).rows[0]?.session_epoch ?? '0' : null;
    if (!live || live.account_epoch !== epoch || live.role !== station.user.role)
        throw new HttpError(401, 'TERMINAL_SESSION_REVOKED', 'Saisissez à nouveau votre code personnel.');
    await assertCuttingTarget(tx, ofId, operationId);
}
