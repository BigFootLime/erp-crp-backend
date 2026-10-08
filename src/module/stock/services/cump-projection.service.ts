import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { PoolClient } from 'pg';
import { reconcileCumpOpenings } from '../domain/cump-opening';
import { readCumpMaterialReturnOriginal } from '../domain/cump-material-return-source';
import { readCumpPostingSource, checkCumpTransferGroup, type CumpJournalSource,
  type CumpPostingSource } from '../domain/cump-posting-source';
import { applyCumpTransition, CUMP_FORMULA_VERSION, type CumpTransition } from '../domain/cump-valuation';
import * as repository from '../repository/cump-projection.repository';
import { CUMP_CONTROL_SQL, CUMP_ADVANCE_CONTROL_SQL } from '../repository/cump-projection.sql';

type Tx = Pick<PoolClient,'query'>;
type Control = { mode: 'PREPARED' | 'ACTIVE'; reporting_currency: string; formula_version: string;
  initialized: boolean; last_sequence: string };
export type CumpProjectionBatch = { mode: 'ABSENT' | 'PREPARED' | 'BUSY' | 'ACTIVE'; processed: number; sequence: string | null };

/** Internal Stock consumer only. The caller owns a READ COMMITTED transaction.
 * The journal barrier seals allocated sequences before reading a window: an
 * identity sequence is NOT commit order. No physical stock row is locked. */
export async function projectCumpWindowTx(tx: Tx, limit = 100): Promise<CumpProjectionBatch> {
  if (!Number.isInteger(limit) || limit<1 || limit>250) throw new Error('CUMP_WINDOW_INVALID');
  const installed = (await tx.query("SELECT to_regclass('public.stock_valuation_projector_control') AS installed")).rows[0]?.installed;
  if (!installed) return { mode: 'ABSENT',processed: 0,sequence: null };
  const acquired = (await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended('stock:cump-projector:1',0)) AS acquired")).rows[0]?.acquired;
  if (!acquired) return { mode: 'BUSY',processed: 0,sequence: null };
  const control = (await tx.query<Control>(CUMP_CONTROL_SQL)).rows[0];
  if (!control) throw new Error('CUMP_CONTROL_MISSING');
  if (control.mode==='PREPARED') return { mode: 'PREPARED',processed: 0,sequence: control.last_sequence };
  if (control.formula_version!==CUMP_FORMULA_VERSION) throw new Error('CUMP_FORMULA_VERSION_UNSUPPORTED');
  const blocked = new Map<string,boolean>();
  if (!control.initialized) {
    const opening = reconcileCumpOpenings(await repository.readCumpOpeningsTx(tx),control.reporting_currency);
    for (const articleId of opening.blockedArticleIds) {
      blocked.set(articleId,true);
      await repository.writeCumpUnresolvedTx(tx,null,articleId,control.reporting_currency,
        opening.issues.filter(issue=>issue.articleId===articleId).map(issue=>issue.code),{ opening_issues: opening.issues.filter(issue=>issue.articleId===articleId) });
    }
    for (const observation of opening.openings) {
      if (!blocked.get(observation.state.scope.articleId)) await repository.writeCumpOpeningTx(tx,observation);
    }
  }
  // SHARE conflicts with journal INSERT's ROW EXCLUSIVE lock, including inserts
  // whose identity was allocated but whose transaction has not committed yet.
  await tx.query('LOCK TABLE public.stock_valuation_movement_journal IN SHARE MODE');
  const started = performance.now();
  const sources = await repository.readCumpSourceWindowTx(tx,control.last_sequence,limit);
  const transferGroups = new Map<string,{ valid: boolean; movementIds: string[] }>();
  let processed = 0,sequence = control.last_sequence;
  for (const row of sources) {
    // Stop only between complete postings; all scopes of one source are atomic.
    if (processed>0 && performance.now()-started>=2000) break;
    const parsed = readCumpPostingSource(row,control.reporting_currency);
    if (!blocked.has(row.article_id)) blocked.set(row.article_id,await repository.cumpArticleBlockedTx(tx,row.article_id));
    if (!parsed.posting || blocked.get(row.article_id)) {
      await repository.writeCumpUnresolvedTx(tx,row,row.article_id,control.reporting_currency,
        parsed.posting ? ['PREVIOUS_STOCK_EVIDENCE_UNRESOLVED'] : parsed.issues);
      blocked.set(row.article_id,true);
    } else {
      const posting = parsed.posting;
      if (posting.kind==='ZERO') await repository.writeCumpZeroTx(tx,row,control.reporting_currency);
      else {
        let transfer: { valid: boolean; movementIds: string[] } | undefined;
        if (posting.transferId) {
          transfer = transferGroups.get(posting.transferId);
          if (!transfer) {
            const groupRows = await repository.readCumpTransferGroupTx(tx,posting.transferId);
            const group = groupRows.map(source=>readCumpPostingSource(source,control.reporting_currency).posting);
            transfer = { valid: group.every(item=>item!==null) && checkCumpTransferGroup(posting,group as CumpPostingSource[]),
              movementIds: groupRows.map(source=>source.movement_id) };
            transferGroups.set(posting.transferId,transfer);
          }
        }
        if ((posting.kind==='TRANSFER' || posting.internalTransferLeg) && !transfer?.valid) {
          await repository.writeCumpUnresolvedTx(tx,row,row.article_id,control.reporting_currency,['STOCK_TRANSFER_GROUP_UNRESOLVED']);
          blocked.set(row.article_id,true);
        } else {
          await tx.query('SAVEPOINT cump_posting');
          try {
            await projectPosting(tx,row,posting,transfer);
            await tx.query('RELEASE SAVEPOINT cump_posting');
          } catch (error) {
            // Permanent unsupported financial precision must not strand all
            // later postings. Database/timeout/programming errors still abort.
            if (!(error instanceof Error) || !/^CUMP_(QUANTITY_PRECISION_UNSUPPORTED|DECIMAL_INVALID)$/.test(error.message)) throw error;
            await tx.query('ROLLBACK TO SAVEPOINT cump_posting');
            await tx.query('RELEASE SAVEPOINT cump_posting');
            await repository.writeCumpUnresolvedTx(tx,row,row.article_id,control.reporting_currency,[error.message]);
            blocked.set(row.article_id,true);
          }
        }
      }
    }
    processed++; sequence = row.sequence;
  }
  if (processed>0 || !control.initialized) {
    const saved = await tx.query(CUMP_ADVANCE_CONTROL_SQL,[sequence]);
    if (saved.rows.length!==1) throw new Error('CUMP_CONTROL_NOT_ADVANCED');
  }
  return { mode: 'ACTIVE',processed,sequence };
}

async function projectPosting(tx: Tx, row: CumpJournalSource, posting: CumpPostingSource,
  transfer?: { valid: boolean; movementIds: string[] }): Promise<void> {
  // Fee quantity is counted once per receipt, never once per owner scope/portion.
  const materialReturn = posting.reversalOfId ? null : readCumpMaterialReturnOriginal(row,posting.scopes[0].scope.currency);
  const originalMovementId = posting.reversalOfId ?? materialReturn?.originalMovementId;
  const acquisition = posting.kind==='RECEIPT' && !originalMovementId && !materialReturn?.detected && !transfer?.valid
    ? await repository.resolveCumpAcquisitionTx(tx,row,posting.scopes[0].scope.currency) : null;
  for (const moved of posting.scopes) {
    const balance = await repository.readCumpBalanceTx(tx,moved.scope) ?? await repository.writeCumpOpeningTx(tx,
      { state: { scope: moved.scope,quantity: '0',value: '0',reliability: 'VERIFIED',sourceRef: null },openingIds: [] },
      { new_scope_after_capture_boundary: true });
    const id = randomUUID(), base = { scope: moved.scope,quantity: moved.quantity,movementRef: `stock-valuation-entry:${id}` };
    let transition: CumpTransition,proof: Record<string,unknown> = {},issues = [...posting.issues];
    if (transfer?.valid) {
      transition = { ...base,kind: 'TRANSFER',destinationScope: moved.scope };
      proof = { transfer_parent_id: posting.transferId,transfer_movement_ids: transfer.movementIds };
    } else if (originalMovementId) {
      const original = await repository.resolveCumpLinkedReturnTx(tx,row,originalMovementId,moved.scope,moved.quantity,id);
      transition = { ...base,kind: original.kind,cost: original.cost,originalMovementRef: originalMovementId };
      proof = { ...original.proof,return_source_sha256: row.return_sha256 ?? null }; issues.push(...original.issues);
    } else if (posting.kind==='RECEIPT') {
      const cost = acquisition && posting.scopes.length===1 && moved.scope.owner==='COMPANY' ? acquisition.cost
        : { amount: null,reliability: 'UNKNOWN' as const,sourceRef: null };
      transition = { ...base,kind: 'RECEIPT',cost };
      proof = acquisition?.proof ?? {}; issues.push(...(acquisition?.issues ?? []));
      if (materialReturn?.detected) {
        proof = { ...proof,return_source_sha256: row.return_sha256 ?? null,material_return_proof_missing: true };
        issues.push(...materialReturn.issues);
      }
      if (posting.scopes.length!==1) issues.push('ACQUISITION_OWNER_PARTITION_UNRESOLVED');
      if (moved.scope.owner!=='COMPANY') issues.push('CLIENT_OWNED_STOCK_EXCLUDED_FROM_COMPANY_VALUE');
    } else if (posting.kind==='ISSUE' || posting.kind==='SCRAP') transition = { ...base,kind: posting.kind };
    else throw new Error('CUMP_POSTING_KIND_UNSUPPORTED');
    const result = applyCumpTransition(balance.state,transition);
    await repository.writeCumpResultTx(tx,row,balance,transition.kind,id,result,proof,issues);
  }
}
