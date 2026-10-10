import { createHash, randomUUID } from 'node:crypto';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { enqueueEntityChanged } from '../../../shared/realtime/realtime-outbox.service';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import { readCrmClient } from '../repository/client-crm.repository';
import { readClientContract, lockContractArticles } from '../repository/client-contract.repository';
import * as repo from '../repository/client-contract-replenishment.repository';
import { readClientContractCoverageTx } from './client-contract-coverage.service';
import { prepareContractReplenishmentWithIntents } from '../domain/client-contract-replenishment-intent-preparation';
import { readReplenishmentProducerIntents } from '../repository/client-contract-replenishment-intents.repository';
import type { AuditContext } from '../repository/client.repository';
import type { ClientReplenishmentPreparationCommand } from '../validators/client-contract-replenishment.validators';
import type { PreparedContractReplenishmentResult } from '../types/client-contract-replenishment.types';

export async function getClientReplenishmentPreparation(clientId: string, contractId: string, planId?: string, page = 1) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (!await readCrmClient(tx, clientId)) throw new HttpError(404, 'CLIENT_NOT_FOUND', 'Client introuvable.');
    if (!await readClientContract(tx, clientId, contractId)) throw new HttpError(404, 'CLIENT_CONTRACT_NOT_FOUND', 'Contrat introuvable pour ce client.');
    const plan = await repo.readReplenishmentPlan(tx, contractId, planId);
    if (planId && !plan) throw new HttpError(404, 'CONTRACT_REPLENISHMENT_PLAN_NOT_FOUND', 'Préparation introuvable pour ce contrat.');
    const history = planId ? await repo.readReplenishmentHistory(tx, contractId, planId, page) : undefined;
    await tx.query('COMMIT');
    return history ? { plan, history } : { plan };
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}

/** Saves a revisable proposal snapshot. Canonical OF generation is a separate capability. */
export async function prepareClientReplenishment(clientId: string, contractId: string,
  command: ClientReplenishmentPreparationCommand, key: string, audit: AuditContext) {
  const hash = createHash('sha256').update(JSON.stringify({ client_id: clientId, contract_id: contractId, command })).digest('hex');
  try {
    return await withRealtimeOutboxTransaction(await pool.connect(), async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`client-replenishment:${audit.user_id}:${key}`]);
      const client = await readCrmClient(tx, clientId, true);
      if (!client) throw new HttpError(404, 'CLIENT_NOT_FOUND', 'Client introuvable.');
      const replay = await repo.readReplenishmentReplay(tx, audit.user_id, key);
      if (replay) {
        if (replay.request_hash !== hash) throw new HttpError(409, 'CONTRACT_REPLENISHMENT_KEY_CONFLICT', 'Cette tentative correspond à une autre préparation.');
        return { result: replay.result_payload, replayed: true };
      }
      if (client.archived_at || client.blocked || client.status === 'inactif')
        throw new HttpError(409, 'CONTRACT_REPLENISHMENT_CLIENT_INACTIVE', 'Le client est inactif ou bloqué.');
      const contract = await readClientContract(tx, clientId, contractId, true);
      if (!contract) throw new HttpError(404, 'CLIENT_CONTRACT_NOT_FOUND', 'Contrat introuvable pour ce client.');
      if (contract.version !== command.expected_contract_version)
        throw new HttpError(409, 'CONTRACT_REPLENISHMENT_CONTRACT_CHANGED', 'Le contrat a changé. Actualisez ses besoins.');
      await lockContractArticles(tx, contract.lines.flatMap(line => line.proposed_article ? [line.proposed_article.article_id] : []));
      const snapshot = await readClientContractCoverageTx(tx, clientId, contractId, { start_month: command.start_month, months: command.months });
      if (snapshot.report.snapshot_hash !== command.expected_snapshot_hash)
        throw new HttpError(409, 'CONTRACT_REPLENISHMENT_COVERAGE_CHANGED', 'Le stock, les besoins ou le planning ont changé. Recalculez avant de préparer.');
      const intents = await readReplenishmentProducerIntents(tx,
        snapshot.contract.lines.map(line => line.proposed_article!.article_id),snapshot.allSources);
      const preparation = prepareContractReplenishmentWithIntents({ report:snapshot.report,today:snapshot.clock.today,
        allDemands:snapshot.allDemands,allSources:snapshot.allSources,allAllocations:snapshot.allAllocations,intents });
      const before = await repo.readReplenishmentPlan(tx, contractId);
      const unchanged = before?.fingerprint === preparation.fingerprint;
      if (!unchanged && (before?.id ?? null) !== command.expected_plan_id)
        throw new HttpError(409, 'CONTRACT_REPLENISHMENT_PLAN_CHANGED', 'Une autre préparation a été enregistrée. Actualisez.');
      let plan = unchanged ? before : null;
      if (!plan) {
        const id = randomUUID();
        await repo.insertReplenishmentPlan(tx, { id, actor: audit.user_id, previousId: before?.id ?? null, preparation,
          proposals: preparation.proposals.map(proposal => ({ ...proposal, id: randomUUID(), plan_id: id })) });
        plan = await repo.readReplenishmentPlan(tx, contractId, id);
        if (!plan) throw new Error('CONTRACT_REPLENISHMENT_WRITE_NOT_VISIBLE');
      }
      const eventId = randomUUID(), result: PreparedContractReplenishmentResult = { event_id: eventId, unchanged, plan };
      await repo.appendReplenishmentEvent(tx, { eventId, contractId, actor: audit.user_id, key, hash, previousId: before?.id ?? null, result });
      const inserted = await repoInsertAuditLog({ tx, user_id: audit.user_id, ip: audit.ip, user_agent: audit.user_agent,
        device_type: audit.device_type, os: audit.os, browser: audit.browser,
        body: { event_type: 'ACTION', action: 'CLIENT_REPLENISHMENT_PREPARE', entity_type: 'client', entity_id: clientId,
          page_key: 'clients.contracts.replenishment', path: audit.path, client_session_id: audit.client_session_id,
          details: { event_id: eventId, plan_id: plan.id, contract_id: contractId, unchanged, proposal_count: plan.proposals.length } } });
      if (!inserted) throw new Error('CONTRACT_REPLENISHMENT_AUDIT_INSERT_FAILED');
      await enqueueEntityChanged(tx, { module: 'clients', entityType: 'CLIENT', entityId: clientId, action: 'updated', at: new Date().toISOString(),
        invalidateKeys: [`client:${clientId}`, 'client-contract-replenishment'] }, { deduplicationKey: `client-replenishment:${eventId}` });
      return { result, replayed: false };
    }, { reconcileCommit: async verifier => {
      const saved = await repo.readReplenishmentReplay(verifier, audit.user_id, key);
      return !saved ? 'not_committed' : saved.request_hash === hash ? 'committed' : 'unknown';
    } });
  } catch (error) {
    const databaseError = error as { code?: string; constraint?: string };
    if (['40001', '40P01'].includes(databaseError.code ?? '') ||
      (databaseError.code === '23505' && databaseError.constraint === 'client_replenishment_current_plan_idx'))
      throw new HttpError(409, 'CONTRACT_REPLENISHMENT_CONCURRENT_CHANGE', 'Les besoins ont changé pendant la préparation. Actualisez puis réessayez.');
    throw error;
  }
}
