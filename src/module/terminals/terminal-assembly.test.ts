import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { assertNativeAssemblyOperation, assertNativeAssemblyCommandScope } from './domain/terminal-assembly';
import { authorizeNativeTerminalSessionTx } from './repository/native-terminal-session.repository';
import type { Terminal } from './repository/terminal-auth.repository';
import type { OperationContext } from './repository/terminal-dossier.repository';
import type { StationContext } from '../production/middlewares/station-authorization.middleware';

// Prepared for the final combined acceptance; not executed per increment.
const machine = '11111111-1111-4111-8111-111111111111';
const terminal = { kind: 'OPERATOR', machine_id: machine, device_id: 'device', id: 'terminal', site_code: 'QA' } as Terminal;
const station = { device_id: 'device', machine_id: machine, session_id: 'session',
  user: { id: 7, role: 'Opérateur' } } as StationContext;
const context: OperationContext = { of_id: 12, operation_id: machine, phase: 30, designation: 'Montage', status: 'READY',
  machine_id: machine, piece_technique_id: machine, piece_technique_version_id: machine,
  technical_snapshot: { operations: [{ phase: 30, type_operation: 'ASSEMBLAGE' }] }, technical_snapshot_sha256: null,
  technical_readiness: 'VALIDATED', quantite_lancee: 100, numero: 'QA-OF-12', statut: 'PLANIFIE' };
describe('native montage command boundaries', () => {
  it('accepts only an unambiguous frozen assembly phase on an operator terminal', () => {
    expect(() => assertNativeAssemblyOperation(terminal, context)).not.toThrow();
    expect(() => assertNativeAssemblyOperation({ ...terminal, kind: 'CUTTING' }, context)).toThrowError(expect.objectContaining({ code: 'TERMINAL_ASSEMBLY_SCOPE' }));
    expect(() => assertNativeAssemblyOperation(terminal, { ...context, technical_snapshot: { operations: [
      { phase: 30, type_operation: 'FRAISAGE' }, { phase: 30, type_operation: 'ASSEMBLAGE' }] } })).toThrowError(expect.objectContaining({ code: 'TERMINAL_ASSEMBLY_SCOPE' }));
  });
  it('rejects a different operation or confirmation key before stock work', () => {
    expect(() => assertNativeAssemblyCommandScope('op1', 'op2', 'key', 'key')).toThrowError(expect.objectContaining({ code: 'TERMINAL_ASSEMBLY_SCOPE' }));
    expect(() => assertNativeAssemblyCommandScope('op1', 'op1', 'key1', 'key2')).toThrowError(expect.objectContaining({ code: 'TERMINAL_ASSEMBLY_SCOPE' }));
  });
});
describe('transactional native operator session', () => {
  const query = vi.fn(), tx = { query } as unknown as PoolClient;
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ id: 7 }] }).mockResolvedValueOnce({ rows: [{ status: 'ACTIVE', machine_id: machine, auto_lock_seconds: 180 }] })
      .mockResolvedValueOnce({ rows: [{ account_epoch: '2', role: 'Opérateur' }] }).mockResolvedValueOnce({ rows: [{ session_epoch: '2' }] });
  });
  it('allows a live scoped session while holding the account/device/PIN/epoch locks', async () => {
    await expect(authorizeNativeTerminalSessionTx(tx, terminal, station, 'OPERATOR')).resolves.toBeUndefined();
    expect(query.mock.calls[2][1]).toEqual(['terminal', 'device', 'session', 'QA', 7, 180, 'OPERATOR', machine]);
  });
  it('rejects a different device without accepting another operator’s session', async () => {
    await expect(authorizeNativeTerminalSessionTx(tx, terminal, { ...station, device_id: 'other' }, 'OPERATOR')).rejects.toMatchObject({ code: 'TERMINAL_KIND_FORBIDDEN' });
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects session invalidation after MFA recovery', async () => {
    query.mockReset(); query.mockResolvedValueOnce({ rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rows: [{ status: 'ACTIVE', machine_id: machine, auto_lock_seconds: 180 }] })
      .mockResolvedValueOnce({ rows: [{ account_epoch: '1', role: 'Opérateur' }] }).mockResolvedValueOnce({ rows: [{ session_epoch: '2' }] });
    await expect(authorizeNativeTerminalSessionTx(tx, terminal, station, 'OPERATOR')).rejects.toMatchObject({ code: 'TERMINAL_SESSION_REVOKED' });
  });
  it('rejects reassignment of the device to another machine during a request', async () => {
    query.mockReset(); query.mockResolvedValueOnce({ rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rows: [{ status: 'ACTIVE', machine_id: 'other', auto_lock_seconds: 180 }] });
    await expect(authorizeNativeTerminalSessionTx(tx, terminal, station, 'OPERATOR')).rejects.toMatchObject({ code: 'TERMINAL_DEVICE_REJECTED' });
  });
});
