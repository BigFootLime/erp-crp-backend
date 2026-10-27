#!/usr/bin/env node
/* TEST-only Directory authority host. Configuration is written outside git. */
if (process.env.NODE_ENV !== 'test' || process.env.CERP_INTERCOMPANY_IDENTITY_FIXTURE !== '1') {
  throw new Error('INTERCOMPANY_IDENTITY_FIXTURE_ONLY');
}
require('ts-node/register/transpile-only');
const { Pool } = require('pg');
const { createDirectoryServer } = require('../../src/shared-directory/server');
const { readDirectoryCallerKeys } = require('../../src/shared-directory/caller-keys');

async function main() {
  const port = Number(process.env.CERP_INTERCOMPANY_DIRECTORY_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INTERCOMPANY_DIRECTORY_PORT_INVALID');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const keys = () => readDirectoryCallerKeys(process.env.CERP_DIRECTORY_CALLERS_FILE);
  const server = createDirectoryServer({
    db: pool,
    directoryId: process.env.CERP_SHARED_DIRECTORY_ID,
    sourceJwtSecret: process.env.JWT_SECRET,
    keys,
    businessCompaniesEnabled: true,
  });
  await server.initialize();
  const listener = server.app.listen(port, '127.0.0.1');
  const stop = () => { server.close(); listener.close(() => void pool.end().finally(() => process.exit(0))); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
void main().catch(async (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
