import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import type { StationContext } from '../../production/middlewares/station-authorization.middleware';
import type { Terminal } from './terminal-auth.repository';
import { NATIVE_TERMINAL_ACCOUNT_SQL, NATIVE_TERMINAL_DEVICE_SQL, NATIVE_TERMINAL_SESSION_SQL,
  NATIVE_TERMINAL_EPOCH_SQL } from './native-terminal-session.sql';

/** Native PIN sessions use last_input_at. Locks live through the owning stock
 * transaction so revocation/assignment changes cannot cross its write. */
export async function authorizeNativeTerminalSessionTx(tx: PoolClient, terminal: Terminal,
  station: StationContext, kind: 'OPERATOR' | 'CUTTING') {
  if (terminal.kind !== kind || (kind === 'CUTTING' ? terminal.machine_id !== null : !terminal.machine_id)
    || station.device_id !== terminal.device_id || station.machine_id !== terminal.machine_id) {
    throw new HttpError(403, 'TERMINAL_KIND_FORBIDDEN', 'Ce poste n’est pas autorisé pour cette opération.');
  }
  if (!(await tx.query(NATIVE_TERMINAL_ACCOUNT_SQL, [station.user.id])).rows[0]) {
    throw new HttpError(401, 'TERMINAL_ACCOUNT_REJECTED', 'Terminez la récupération du compte avant de reprendre le poste.');
  }
  const device = (await tx.query<{ status: string; machine_id: string | null; auto_lock_seconds: number }>(
    NATIVE_TERMINAL_DEVICE_SQL, [terminal.device_id])).rows[0];
  if (device?.status !== 'ACTIVE' || device.machine_id !== terminal.machine_id
    || !Number.isInteger(device.auto_lock_seconds) || device.auto_lock_seconds <= 0) {
    throw new HttpError(401, 'TERMINAL_DEVICE_REJECTED', 'Ce poste n’est plus autorisé.');
  }
  const live = (await tx.query<{ account_epoch: string; role: string }>(NATIVE_TERMINAL_SESSION_SQL,
    [terminal.id, terminal.device_id, station.session_id, terminal.site_code, station.user.id,
      device.auto_lock_seconds, kind, terminal.machine_id])).rows[0];
  const epoch = live ? (await tx.query<{ session_epoch: string }>(NATIVE_TERMINAL_EPOCH_SQL,
    [station.user.id])).rows[0]?.session_epoch ?? '0' : null;
  if (!live || live.account_epoch !== epoch || live.role !== station.user.role) {
    throw new HttpError(401, 'TERMINAL_SESSION_REVOKED', 'Saisissez à nouveau votre code personnel.');
  }
}
