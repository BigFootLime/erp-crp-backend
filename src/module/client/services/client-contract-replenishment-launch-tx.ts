import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { enqueueEntityChanged } from '../../../shared/realtime/realtime-outbox.service';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import { createRecursiveOrdresFabrication } from '../../production/domain/of-generation';
import { roleHasOfCapability } from '../../production/domain/of-rbac';
import { parseCumpDecimal } from '../../stock/domain/cump-decimal';
import { readReplenishmentPlan } from '../repository/client-contract-replenishment.repository';
import type { AuditContext } from '../repository/client.repository';
import type { prepareContractReplenishmentWithIntents } from '../domain/client-contract-replenishment-intent-preparation';
import type { PreparedContractReplenishmentPlan } from '../types/client-contract-replenishment.types';
import { getAccountModuleAccessContext } from '../../access-control/context/account-module-access.context';

type Tx = Pick<PoolClient, 'query'>;
type FreshPreparation = ReturnType<typeof prepareContractReplenishmentWithIntents>;
export type ReplenishmentLaunchResult = {
  launch_id: string; plan_id: string; contract_id: string;
  roots: { proposal_id: string; root_of_id: number; number: string; batch_id: string;
    article_id: string; quantity: string; target_date: string; target_overdue: boolean; child_of_ids: number[] }[];
};

/** Internal transaction primitive, not an API entry point. The caller owns
 * commit/reconciliation and supplies the shared intent reader. That reader is
 * invoked here on the same SERIALIZABLE transaction, never on a second pool.
 * Routing remains disabled until received/grouped producers are reconciled. */
export async function launchPreparedContractReplenishmentTx(tx: Tx, input: {
  client_id: string; contract_id: string; plan_id: string; proposal_ids: readonly string[];
  key: string; request_hash: string; audit: AuditContext; user_role: string | null | undefined;
  rereadSharedPreparation: (tx: Tx, plan: PreparedContractReplenishmentPlan) => Promise<FreshPreparation>;
}) {
  // A client-module grant must not implicitly become a production grant through
  // the legacy role helper's global context. Route generation under production.
  const access = getAccountModuleAccessContext();
  if ((access?.granted && (access.userId !== input.audit.user_id || (access.moduleKey !== 'production' && !access.elevated)))
    || !roleHasOfCapability(input.user_role, 'generate'))
    throw new HttpError(403, 'CONTRACT_REPLENISHMENT_GENERATE_FORBIDDEN', 'Vous ne pouvez pas générer les OF de réapprovisionnement.');
  if (!input.proposal_ids.length || input.proposal_ids.length > 100 || new Set(input.proposal_ids).size !== input.proposal_ids.length)
    throw new HttpError(422, 'CONTRACT_REPLENISHMENT_SELECTION_INVALID', 'Sélectionnez de 1 à 100 propositions distinctes.');
  if (!/^[0-9a-f]{64}$/.test(input.request_hash)) throw new Error('CONTRACT_REPLENISHMENT_REQUEST_HASH_REQUIRED');
  const isolation = (await tx.query<{ transaction_isolation: string }>('SHOW transaction_isolation')).rows[0];
  if (isolation?.transaction_isolation !== 'serializable') throw new Error('CONTRACT_REPLENISHMENT_SERIALIZABLE_TRANSACTION_REQUIRED');
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`client-replenishment-launch:${input.audit.user_id}:${input.key}`]);
  const replay = (await tx.query<{ client_id: string; contract_id: string; request_hash: string; result_payload: ReplenishmentLaunchResult }>(
    `SELECT contract.client_id::text,launch.contract_id::text,launch.request_hash,launch.result_payload
     FROM public.client_contract_replenishment_launches launch JOIN public.client_contracts contract ON contract.id=launch.contract_id
     WHERE launch.actor_user_id=$1 AND launch.idempotency_key=$2::uuid`, [input.audit.user_id, input.key])).rows[0];
  if (replay) {
    if (replay.client_id !== input.client_id || replay.contract_id !== input.contract_id || replay.request_hash !== input.request_hash)
      throw new HttpError(409, 'CONTRACT_REPLENISHMENT_KEY_CONFLICT', 'Cette tentative correspond à un autre lancement.');
    return { result: replay.result_payload, replayed: true };
  }
  const owner = (await tx.query<{ version: number }>(`SELECT contract.version FROM public.client_contracts contract
    JOIN public.clients client ON client.client_id=contract.client_id
    WHERE contract.id=$1::uuid AND contract.client_id=$2 AND contract.status='ACTIVE'
      AND client.archived_at IS NULL AND NOT COALESCE(client.blocked,false) AND client.status IS DISTINCT FROM 'inactif'
    FOR SHARE OF contract,client`, [input.contract_id, input.client_id])).rows[0];
  if (!owner) throw new HttpError(409, 'CONTRACT_REPLENISHMENT_OWNER_INACTIVE', 'Le client ou son contrat n’est plus actif. Actualisez.');
  await tx.query(`SELECT id FROM public.client_contract_replenishment_plans
    WHERE id=$1::uuid AND contract_id=$2::uuid FOR SHARE`, [input.plan_id, input.contract_id]);
  const plan = await readReplenishmentPlan(tx, input.contract_id, input.plan_id);
  if (!plan || plan.status !== 'CURRENT' || plan.contract_version !== owner.version)
    throw new HttpError(409, 'CONTRACT_REPLENISHMENT_PLAN_CHANGED', 'La préparation ou le contrat a changé. Recalculez ses besoins.');
  const selected = [...input.proposal_ids].sort().map(id => plan.proposals.find(proposal => proposal.id === id));
  if (selected.some(proposal => !proposal))
    throw new HttpError(409, 'CONTRACT_REPLENISHMENT_PROPOSAL_CHANGED', 'Une proposition n’appartient plus à cette préparation. Actualisez.');
  const existing = (await tx.query(`SELECT proposal_id FROM public.client_contract_replenishment_roots
    WHERE proposal_id=ANY($1::uuid[])`, [input.proposal_ids])).rows;
  if (existing.length) throw new HttpError(409, 'CONTRACT_REPLENISHMENT_ALREADY_LAUNCHED', 'Un OF existe déjà pour une proposition sélectionnée. Actualisez les besoins.');
  const fresh = await input.rereadSharedPreparation(tx, plan);
  if (fresh.fingerprint !== plan.fingerprint || fresh.report.contract_id !== input.contract_id
    || fresh.report.contract_version !== plan.contract_version || fresh.report.snapshot_hash !== plan.coverage_snapshot_hash)
    throw new HttpError(409, 'CONTRACT_REPLENISHMENT_COVERAGE_CHANGED', 'Le stock, les besoins ou les OF prévus ont changé. Repréparez avant de lancer.');
  // Validate the whole selection before the first canonical engine invocation.
  for (const proposal of selected) {
    if (!proposal || !/^\d+(\.\d{1,3})?$/.test(proposal.proposed_quantity)
      || parseCumpDecimal(proposal.proposed_quantity) <= 0n || parseCumpDecimal(proposal.proposed_quantity) > parseCumpDecimal('1000000000'))
      throw new HttpError(422, 'CONTRACT_REPLENISHMENT_QUANTITY_INVALID', 'La quantité de la proposition est hors du périmètre de génération.');
  }
  const result: ReplenishmentLaunchResult = { launch_id: randomUUID(), plan_id: plan.id, contract_id: input.contract_id, roots: [] };
  for (const proposal of selected) {
    if (!proposal) throw new Error('CONTRACT_REPLENISHMENT_SELECTION_NOT_VALIDATED');
    const generated = await createRecursiveOrdresFabrication(tx, {
      source_type: 'MANUAL', commande_id: null, commande_numero: null, commande_ligne_id: null, livraison_affaire_id: null,
      client_id: input.client_id, root_article_id: proposal.article.article_id, root_piece_technique_id: proposal.article.piece_technique_id,
      root_pinned_version_id: proposal.article.piece_technique_version_id, qty_to_produce: Number(proposal.proposed_quantity),
      user_id: input.audit.user_id, force_preparation: true, idempotency_key: proposal.id,
      request_hash: createHash('sha256').update(JSON.stringify({ plan: plan.id, proposal })).digest('hex'),
    });
    const root = (await tx.query<{ numero: string }>('SELECT numero FROM public.ordres_fabrication WHERE id=$1', [generated.root_of_id])).rows[0];
    if (!root?.numero) throw new Error('CONTRACT_REPLENISHMENT_ROOT_NOT_VISIBLE');
    result.roots.push({ proposal_id: proposal.id, root_of_id: generated.root_of_id, number: root.numero,
      batch_id: generated.batch_id, article_id: proposal.article.article_id, quantity: proposal.proposed_quantity,
      target_date: proposal.target_date, target_overdue: proposal.target_overdue,
      child_of_ids: generated.ofs.filter(of => of.parent_of_id !== null).map(of => of.id) });
  }
  await tx.query(`INSERT INTO public.client_contract_replenishment_launches(id,plan_id,contract_id,actor_user_id,
    idempotency_key,request_hash,intent_snapshot_hash,result_payload) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8::jsonb)`,
  [result.launch_id, plan.id, input.contract_id, input.audit.user_id, input.key, input.request_hash, fresh.intent_fingerprint, JSON.stringify(result)]);
  for (const root of result.roots) {
    const proposal = plan.proposals.find(item => item.id === root.proposal_id)!;
    await tx.query(`INSERT INTO public.client_contract_replenishment_roots(launch_id,plan_id,contract_id,proposal_id,root_of_id,
      article_id,piece_technique_id,piece_technique_version_id,unit_id,quantity,target_date)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10::numeric,$11::date)`,
    [result.launch_id, plan.id, input.contract_id, proposal.id, root.root_of_id, proposal.article.article_id,
      proposal.article.piece_technique_id, proposal.article.piece_technique_version_id, proposal.article.unit_id, proposal.proposed_quantity, proposal.target_date]);
  }
  const inserted = await repoInsertAuditLog({ tx, user_id: input.audit.user_id, ip: input.audit.ip, user_agent: input.audit.user_agent,
    device_type: input.audit.device_type, os: input.audit.os, browser: input.audit.browser,
    body: { event_type: 'ACTION', action: 'CLIENT_REPLENISHMENT_GENERATE', entity_type: 'client', entity_id: input.client_id,
      page_key: 'clients.contracts.replenishment', path: input.audit.path, client_session_id: input.audit.client_session_id,
      details: { launch_id: result.launch_id, plan_id: plan.id, contract_id: input.contract_id, roots: result.roots } } });
  if (!inserted) throw new Error('CONTRACT_REPLENISHMENT_AUDIT_INSERT_FAILED');
  await enqueueEntityChanged(tx, { module: 'clients', entityType: 'CLIENT', entityId: input.client_id, action: 'updated',
    at: new Date().toISOString(), invalidateKeys: [`client:${input.client_id}`, 'client-contract-replenishment'] },
  { deduplicationKey: `client-replenishment-launch:${result.launch_id}` });
  return { result, replayed: false };
}
