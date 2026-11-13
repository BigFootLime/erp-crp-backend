import { createHash } from 'node:crypto';
import { z } from 'zod';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { withRealtimeOutboxTransaction } from '../../../shared/realtime/realtime-outbox-transaction';
import { lockContractArticles } from '../repository/client-contract.repository';
import { readReplenishmentLaunchReplay } from '../repository/client-contract-replenishment-launch.repository';
import { readReplenishmentProducerIntents } from '../repository/client-contract-replenishment-intents.repository';
import { prepareContractReplenishmentWithIntents } from '../domain/client-contract-replenishment-intent-preparation';
import { clientReplenishmentLaunchSchema, type ClientReplenishmentLaunchCommand } from '../validators/client-contract-replenishment.validators';
import type { AuditContext } from '../repository/client.repository';
import { readClientContractCoverageTx } from './client-contract-coverage.service';
import { launchPreparedContractReplenishmentTx } from './client-contract-replenishment-launch-tx';

/** Canonical production generation service. Unresolved producer dispositions
 * fail during the shared recheck before the first OF can be created. */
export async function generateClientContractReplenishment(clientId: string, contractId: string,
  command: ClientReplenishmentLaunchCommand, key: string, audit: AuditContext, userRole: string | null | undefined) {
  const parsed = clientReplenishmentLaunchSchema.safeParse(command), parsedKey = z.string().uuid().safeParse(key);
  const parsedContract = z.string().uuid().safeParse(contractId);
  if (!parsed.success || !parsedKey.success || !parsedContract.success)
    throw new HttpError(422, 'CONTRACT_REPLENISHMENT_SELECTION_INVALID', 'Sélectionnez une préparation et de 1 à 100 propositions distinctes.');
  const contract = parsedContract.data.toLowerCase();
  const canonical = { ...parsed.data, proposal_ids: [...parsed.data.proposal_ids].sort() };
  const requestKey = parsedKey.data.toLowerCase();
  const hash = createHash('sha256').update(JSON.stringify({ client_id: clientId, contract_id: contract, command: canonical })).digest('hex');
  try {
    return await withRealtimeOutboxTransaction(await pool.connect(), async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const installed = (await tx.query<{ installed: boolean }>(`SELECT
        to_regclass('public.client_contract_replenishment_launches') IS NOT NULL
        AND to_regclass('public.client_contract_replenishment_roots') IS NOT NULL
        AND to_regprocedure('public.fn_client_replenishment_fixed_lots_1032()') IS NOT NULL AS installed`)).rows[0];
      if (!installed?.installed)
        throw new HttpError(409, 'CONTRACT_REPLENISHMENT_NOT_INSTALLED', 'Le lancement du réapprovisionnement n’est pas encore installé. Contactez l’administrateur.');
      return launchPreparedContractReplenishmentTx(tx, {
        client_id: clientId, contract_id: contract, plan_id: canonical.plan_id, proposal_ids: canonical.proposal_ids,
        key: requestKey, request_hash: hash, audit, user_role: userRole,
        rereadSharedPreparation: async (sameTx, plan) => {
          await lockContractArticles(sameTx, [...new Set(plan.proposals.map(proposal => proposal.article.article_id))]);
          const snapshot = await readClientContractCoverageTx(sameTx, clientId, contract,
            { start_month: plan.start_month, months: plan.months });
          const intents = await readReplenishmentProducerIntents(sameTx,
            snapshot.contract.lines.map(line => line.proposed_article!.article_id), snapshot.allSources);
          return prepareContractReplenishmentWithIntents({ report: snapshot.report, today: snapshot.clock.today,
            allDemands: snapshot.allDemands, allSources: snapshot.allSources, allAllocations: snapshot.allAllocations, intents });
        },
      });
    }, { reconcileCommit: async (verifier, result) => {
      const saved = await readReplenishmentLaunchReplay(verifier, audit.user_id, requestKey);
      if (!saved) return 'not_committed';
      return saved.client_id === clientId && saved.contract_id === contract && saved.request_hash === hash
        && saved.result_payload.launch_id === result.result.launch_id ? 'committed' : 'unknown';
    } });
  } catch (error) {
    const dbError = error as { code?: string; constraint?: string };
    if (['40001', '40P01'].includes(dbError.code ?? '') || (dbError.code === '23505'
      && ['client_contract_replenishment_roots_proposal_id_key', 'client_replenishment_roots_proposal_lot_key',
        'client_contract_replenishment_roots_root_of_id_key'].includes(dbError.constraint ?? '')))
      throw new HttpError(409, 'CONTRACT_REPLENISHMENT_CONCURRENT_CHANGE', 'La préparation ou ses OF ont changé pendant le lancement. Actualisez puis réessayez avec la même tentative.');
    throw error;
  }
}
