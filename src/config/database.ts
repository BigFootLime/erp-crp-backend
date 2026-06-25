import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: readPositiveIntEnv('PG_POOL_MAX', 10),
  connectionTimeoutMillis: readPositiveIntEnv('PG_CONNECTION_TIMEOUT_MS', 5_000),
  idleTimeoutMillis: readPositiveIntEnv('PG_IDLE_TIMEOUT_MS', 30_000),
  maxLifetimeSeconds: readPositiveIntEnv('PG_MAX_LIFETIME_SECONDS', 300),
  statement_timeout: readPositiveIntEnv('PG_STATEMENT_TIMEOUT_MS', 20_000),
  query_timeout: readPositiveIntEnv('PG_QUERY_TIMEOUT_MS', 25_000),
  lock_timeout: readPositiveIntEnv('PG_LOCK_TIMEOUT_MS', 5_000),
  idle_in_transaction_session_timeout: readPositiveIntEnv('PG_IDLE_TX_TIMEOUT_MS', 15_000),
});

pool.on('connect', () => {
  console.log('🟢 Connecté à PostgreSQL avec succès');
});

pool.on('error', (err) => {
  console.error('❌ Erreur de connexion PostgreSQL', err);
});

export default pool;
