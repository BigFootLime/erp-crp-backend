import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { materialPropertiesFingerprint } from '../domain/of-material';
import { readOperationalLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';
import { OF_COMPONENT_CONTEXT_SQL, OF_COMPONENT_REQUIREMENTS_SQL, OF_COMPONENT_RESERVATIONS_SQL } from './of-component-coverage.sql';

type Db = Pick<PoolClient, 'query'>;
type Requirement = {
  id: string; kind: string; status: string; action: string; path: string;
  articleId: string | null; pieceId: string | null; label: string; unit: string | null;
  childOfId: number | null; childNumber: string | null; childStatus: string | null;
  required: number; updatedAt: string;
  quantityPerParent: string; consumedQuantity: number; parentVersionId: string;
  sourceOfId: number;
};
type Reservation = {
  id: string; requirementId: string; lotId: string | null; lotCode: string | null;
  scope: string | null; quantity: number; physical: boolean | null; updatedAt: string;
  rowVersion: number;
};

/** Read the same physical component gate before preparation and before start.
 * Expected child production is shown separately; it never counts as released stock. */
export async function readOfComponentCoverageTx(tx: Db, ofId: number, requireDefined?: boolean) {
  const of = (await tx.query<{ number: string; assembly: boolean; producerId: number | null;
    quantity: number; executionStatus: string; versionId: string | null }>(OF_COMPONENT_CONTEXT_SQL, [ofId])).rows[0];
  if (!of) throw new HttpError(404, 'OF_NOT_FOUND', 'OF introuvable.');
  const requirements = (await tx.query<Requirement>(OF_COMPONENT_REQUIREMENTS_SQL, [ofId])).rows;
  const reservations = (await tx.query<Reservation>(OF_COMPONENT_RESERVATIONS_SQL, [ofId])).rows;
  const quality = new Map<string, Awaited<ReturnType<typeof readOperationalLotQualityEligibility>>>();
  for (const r of reservations) {
    if (!r.lotId || !r.physical || quality.has(r.lotId)) continue;
    quality.set(r.lotId, await readOperationalLotQualityEligibility({client:tx,lotId:r.lotId,qty:0,purpose:'RESERVE'}));
  }
  const items = requirements.map(n => {
    const lots = reservations.filter(r => r.requirementId === n.id).map(r => {
      const blocks = !r.lotId || !r.physical
        ? ['Le lot réservé ne dispose pas du stock physique libéré attendu.']
        : (quality.get(r.lotId)?.eligibility.blocks ?? []).map(b => b.message);
      return {...r, usable:blocks.length ? 0 : r.quantity, blockers:blocks};
    });
    const reserved = lots.reduce((sum,r) => sum+r.quantity,0), usable = lots.reduce((sum,r) => sum+r.usable,0);
    const consumed = n.required > 0 && n.consumedQuantity >= n.required - 1e-9;
    const remaining = Math.max(0, n.required - n.consumedQuantity);
    const missing = Math.max(0,remaining-usable);
    const blockers = [...new Set(lots.flatMap(r => r.blockers))];
    return {...n,reserved,usable,missing,remaining,consumed,lots,blockers,
      ready:consumed || (reserved>=remaining-1e-9 && usable>=remaining-1e-9 && !blockers.length)};
  });
  const assembly = requireDefined ?? of.assembly;
  const definitionMissing = assembly && !items.length;
  const ready = !definitionMissing && items.every(n => n.ready);
  const version = materialPropertiesFingerprint({ofId,of,requirements,reservations,
    quality:[...quality].map(([id,q])=>[id,q.target,q.already_committed_qty,q.eligibility]),ready});
  return {ofId,number:of.number,quantity:of.quantity,executionStatus:of.executionStatus,versionId:of.versionId,
    assembly,coveredByOfId:of.producerId,definitionMissing,ready,version,items};
}

export async function getOfComponentCoverage(ofId: number) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const state = await readOfComponentCoverageTx(tx,ofId);
    await tx.query('COMMIT');
    return state;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}
