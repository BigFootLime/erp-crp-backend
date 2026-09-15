import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
const connection = vi.hoisted(() => ({connect: vi.fn()}));
vi.mock('../config/database', () => ({default: connection}));
import {seedProductionWorkbenchFixture} from './fixtures/production-workbench.fixture';

beforeEach(() => {
  connection.connect.mockReset().mockRejectedValue(new Error('ISOLATED_CONNECTION_REACHED'));
  vi.stubEnv('CERP_E2E_ISOLATED', '1');
  vi.stubEnv('CERP_E2E_MANAGED_STACK', '1');
  vi.stubEnv('CERP_E2E_DB_PORT', '55432');
  vi.stubEnv('DATABASE_URL', 'postgresql://cerp_e2e:dummy@127.0.0.1:55432/cerp_test');
});
afterEach(() => vi.unstubAllEnvs());

describe('workbench fixture database boundary', () => {
  it.each(['55432', '55973'])('allows the managed disposable port %s to reach its connection', async port => {
    vi.stubEnv('CERP_E2E_DB_PORT', port);
    vi.stubEnv('DATABASE_URL', `postgresql://cerp_e2e:dummy@127.0.0.1:${port}/cerp_test`);
    await expect(seedProductionWorkbenchFixture()).rejects.toThrow('ISOLATED_CONNECTION_REACHED');
    expect(connection.connect).toHaveBeenCalledTimes(1);
  });
  it('preserves the dedicated legacy fixture boundary', async () => {
    vi.stubEnv('CERP_E2E_MANAGED_STACK', '0');
    vi.stubEnv('DATABASE_URL', 'postgresql://cerp_712@127.0.0.1:55432/cerp_test');
    await expect(seedProductionWorkbenchFixture()).rejects.toThrow('ISOLATED_CONNECTION_REACHED');
  });
  it.each([
    ['DATABASE_URL', 'postgresql://cerp_e2e:dummy@192.0.2.1:55432/cerp_test'],
    ['DATABASE_URL', 'postgresql://cerp_e2e:dummy@127.0.0.1:55432/cerp_prod'],
    ['DATABASE_URL', 'postgresql://postgres:dummy@127.0.0.1:55432/cerp_test'],
    ['CERP_E2E_ISOLATED', '0'],
    ['CERP_E2E_MANAGED_STACK', '0'],
    ['CERP_E2E_DB_PORT', '55973'],
    ['CERP_E2E_DB_PORT', '543'],
    ['CERP_E2E_DB_PORT', '65536'],
    ['CERP_E2E_DB_PORT', 'invalid'],
  ])('rejects %s=%s before connecting', async (key, value) => {
    vi.stubEnv(key, value);
    await expect(seedProductionWorkbenchFixture()).rejects.toThrow('Isolated fixture only');
    expect(connection.connect).not.toHaveBeenCalled();
  });
});
