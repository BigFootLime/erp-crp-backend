import pool from '../../../config/database';
import { logger, safeErrorCode } from '../../../shared/observability/logger';
import { projectCumpWindowTx, type CumpProjectionBatch } from './cump-projection.service';

/** An uncertain COMMIT is retried from the durable cursor, never from an
 * in-memory list. Entries, balances and allocation cursors share one commit. */
export async function runCumpProjectionOnce(): Promise<CumpProjectionBatch> {
  const client = await pool.connect();
  let released = false,open = false,committing = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); open = true;
    await client.query("SET LOCAL statement_timeout='8s'");
    await client.query("SET LOCAL lock_timeout='500ms'");
    const result = await projectCumpWindowTx(client);
    committing = true;
    await client.query('COMMIT'); open = false;
    return result;
  } catch (error) {
    if (committing) { client.release(true); released = true; }
    else if (open) {
      try { await client.query('ROLLBACK'); }
      catch { client.release(true); released = true; }
    }
    throw error;
  } finally { if (!released) client.release(); }
}

export function startCumpProjectionMaintenance() {
  let running: Promise<unknown> | null = null,stopped = false,lastLoggedFailure: string | null = null;
  const cycle = () => {
    if (stopped || running) return;
    running = runCumpProjectionOnce().then(()=>{ lastLoggedFailure = null; }).catch(error=>{
      const failure = safeErrorCode(error);
      // A short busy journal is expected; leave its cursor intact for next tick.
      if (failure==='55P03' || failure==='57014') return;
      if (failure!==lastLoggedFailure) logger.error('stock_cump_projection_failed',{ failure_code: failure });
      lastLoggedFailure = failure;
    }).finally(()=>{ running = null; });
  };
  const timer = setInterval(cycle,30000); timer.unref?.(); cycle();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
