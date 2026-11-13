import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { formatCumpDecimal, parseCumpDecimal } from '../../stock/domain/cump-decimal';
import { readOperationalLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';
import type { ContractCoverageIssue, ContractCoverageSupply } from '../types/client-contract-coverage.types';

type Queryer = Pick<PoolClient, 'query'>;
type Position = { position_id: string; stock_level_id: string; stock_batch_id: string | null;
  article_id: string; unit: string; lot_id: string | null; lot_code: string | null;
  lane: string | null; source_scope: string; physical_qty: string; usable_physical: string;
  reserved_qty: string; unreserved_qty: string; unexplained_reserved_qty: string };
type Reservation = { id: string; lot_id: string; stock_level_id: string | null; stock_batch_id: string | null;
  order_line_id: string | null; allocation_id: string | null; quantity: string };
const minimum = (a: bigint, b: bigint) => a < b ? a : b;
const positive = (a: bigint) => a > 0n ? a : 0n;

export const CONTRACT_COVERAGE_POSITIONS_SQL = `SELECT p.position_id::text,p.stock_level_id::text,p.stock_batch_id::text,
  p.article_id::text,upper(btrim(p.unit)) AS unit,p.lot_id::text,p.lot_code,p.lane,p.source_scope,
  p.physical_qty::text,p.reserved_qty::text,p.unreserved_qty::text,p.unexplained_reserved_qty::text,
  GREATEST(p.physical_qty-COALESCE(batch.qty_depreciated,level.qty_depreciated),0)::text AS usable_physical
  FROM public.v_stock_lane_positions_1028 p JOIN public.stock_levels level ON level.id=p.stock_level_id
  LEFT JOIN public.stock_batches batch ON batch.id=p.stock_batch_id
  WHERE p.article_id=ANY($1::uuid[]) ORDER BY p.lot_id,p.position_id LIMIT 1001`;
export const CONTRACT_COVERAGE_RESERVATIONS_SQL = `SELECT r.id::text,r.lot_id::text,r.stock_level_id::text,
  r.stock_batch_id::text,r.commande_ligne_id::text AS order_line_id,
  r.commande_ligne_affaire_allocation_id::text AS allocation_id,
  GREATEST(r.qty_reserved-COALESCE(r.qty_consumed,0),0)::text AS quantity
  FROM public.stock_reservations r WHERE r.lot_id=ANY($1::uuid[]) AND r.status='ACTIVE'
    AND (r.expires_at IS NULL OR r.expires_at>now()) ORDER BY r.created_at,r.id LIMIT 4001`;

/** The existing quality gate uses numbers. Truncate its budget at 0.001; never round release upwards. */
function qualityBudget(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000)
    throw new HttpError(422, 'CONTRACT_COVERAGE_QUALITY_SCOPE_TOO_LARGE', 'Le budget qualité du lot dépasse le périmètre du calcul.');
  return parseCumpDecimal((Math.floor(value * 1000) / 1000).toFixed(3));
}

export async function readContractCoverageStock(db: Queryer, articleIds: readonly string[]) {
  const positions = (await db.query<Position>(CONTRACT_COVERAGE_POSITIONS_SQL, [articleIds])).rows;
  const lotIds = [...new Set(positions.flatMap(p => p.lot_id ? [p.lot_id] : []))];
  if (positions.length > 1000 || lotIds.length > 200)
    throw new HttpError(422, 'CONTRACT_COVERAGE_SCOPE_TOO_LARGE', 'La synthèse dépasse 1 000 positions ou 200 lots. Aucune couverture partielle n’a été produite.');
  const reservations = (await db.query<Reservation>(CONTRACT_COVERAGE_RESERVATIONS_SQL, [lotIds])).rows;
  if (reservations.length > 4000) throw new HttpError(422, 'CONTRACT_COVERAGE_SCOPE_TOO_LARGE', 'La synthèse dépasse 4 000 réservations.');
  const sources: ContractCoverageSupply[] = [], issues: ContractCoverageIssue[] = [];
  if (positions.some(p => !p.lot_id && parseCumpDecimal(p.usable_physical) > 0n))
    issues.push({ code: 'UNIDENTIFIED_STOCK_EXCLUDED', message: 'Le stock sans lot identifié nécessite une revue et reste exclu.' });
  for (const lotId of lotIds.sort()) {
    const lotPositions = positions.filter(p => p.lot_id === lotId);
    const physical = lotPositions.reduce((sum, p) => sum + parseCumpDecimal(p.usable_physical), 0n);
    if (!physical) continue;
    const quantity = Number(formatCumpDecimal(physical));
    if (quantity > 1_000_000_000) throw new HttpError(422, 'CONTRACT_COVERAGE_SCOPE_TOO_LARGE', 'La quantité physique d’un lot dépasse le périmètre du calcul.');
    const decision = await readOperationalLotQualityEligibility({ client: db, lotId, qty: quantity,
      unit: lotPositions[0].unit, purpose: 'RESERVE' });
    let freeBudget = qualityBudget(decision.available);
    const lotReservations = reservations.filter(r => r.lot_id === lotId);
    const activeQuantity = lotReservations.reduce((sum, r) => sum + parseCumpDecimal(r.quantity), 0n);
    const otherCommitments = positive(qualityBudget(decision.already_committed_qty) - activeQuantity);
    let reservedBudget = positive(qualityBudget(decision.eligibility.qty_allowed) - otherCommitments);
    const physicalRemaining = new Map(lotPositions.map(p => [p.position_id,
      minimum(parseCumpDecimal(p.reserved_qty), parseCumpDecimal(p.usable_physical))]));
    for (const reservation of lotReservations) {
      const position = lotPositions.find(p => p.stock_level_id === reservation.stock_level_id
        && p.stock_batch_id === reservation.stock_batch_id);
      const committed = minimum(reservedBudget, parseCumpDecimal(reservation.quantity));
      reservedBudget -= committed;
      if (!position || position.source_scope !== 'NEW') {
        if (committed && reservation.order_line_id) issues.push({ code: 'RESERVED_STOCK_REVIEW_REQUIRED',
          message: 'Une réservation historique ou sans position physique fiable nécessite une revue.' });
        continue;
      }
      const accepted = minimum(committed, physicalRemaining.get(position.position_id)!);
      physicalRemaining.set(position.position_id, physicalRemaining.get(position.position_id)! - accepted);
      if (!accepted || !reservation.order_line_id) continue;
      sources.push({ id: `reservation:${reservation.id}`, kind: 'RESERVED', article_id: position.article_id,
        unit: position.unit, quantity: formatCumpDecimal(accepted), available_date: null,
        order_line_id: reservation.order_line_id, allocation_id: reservation.allocation_id,
        reference_id: reservation.id, label: position.lot_code ?? 'Lot réservé' });
    }
    for (const position of lotPositions) {
      if (position.lane !== 'FREE' || position.source_scope !== 'NEW') continue;
      if (parseCumpDecimal(position.unexplained_reserved_qty, true) !== 0n) {
        issues.push({ code: 'UNEXPLAINED_RESERVATION_EXCLUDED', message: 'Une réserve inexpliquée exclut sa position du stock libre.' }); continue;
      }
      const accepted = minimum(freeBudget, parseCumpDecimal(position.unreserved_qty));
      if (!accepted) continue;
      freeBudget -= accepted;
      sources.push({ id: `stock:${position.position_id}`, kind: 'FREE', article_id: position.article_id,
        unit: position.unit, quantity: formatCumpDecimal(accepted), available_date: null,
        order_line_id: null, allocation_id: null, reference_id: lotId, label: position.lot_code ?? 'Lot libre' });
    }
    if (decision.eligibility.blocks.some(block => block.code !== 'QTY_NOT_RELEASED'))
      issues.push({ code: 'QUALITY_BLOCKED_STOCK_EXCLUDED', message: 'Des pièces bloquées par la qualité restent exclues du stock disponible.' });
  }
  return { sources, issues };
}
