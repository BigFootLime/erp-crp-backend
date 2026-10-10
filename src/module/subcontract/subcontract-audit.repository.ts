import type { PoolClient } from 'pg';
import { repoInsertAuditLog } from '../audit-logs/repository/audit-logs.repository';

/** Keep custody and its complete audit event in the same business transaction. */
export async function appendSubcontractAudit(
  tx: Pick<PoolClient, 'query'>,
  actor: number | null | undefined,
  action: string,
  packageId: string,
  details: unknown,
) {
  await repoInsertAuditLog({
    tx, user_id: actor ?? null,
    ip: null, user_agent: null, device_type: null, os: null, browser: null,
    body: {
      event_type: 'ACTION', action, page_key: 'subcontract',
      entity_type: 'SUBCONTRACT_WORK_PACKAGE', entity_id: packageId, details,
    },
  });
}
