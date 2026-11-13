import { createHash } from 'node:crypto';
import { HttpError } from '../../../utils/httpError';
import { parseCumpDecimal } from '../../stock/domain/cump-decimal';
import type { ContractCoverageResult } from '../types/client-contract-coverage.types';
import type { ContractReplenishmentPreparation } from '../types/client-contract-replenishment.types';

/** Persist only the canonical projection, not quantities edited by the browser. */
export function prepareContractReplenishmentSnapshot(report: ContractCoverageResult, today: string): ContractReplenishmentPreparation {
  const maximum = parseCumpDecimal('1000000000');
  const proposals = report.lines.flatMap(line => line.replenishment_projection.filter(month => month.lot_count !== '0')
    .map(month => {
      if ([month.proposed_quantity, month.lot_quantity, month.surplus_quantity].some(value => !/^\d+(\.\d{1,3})?$/.test(value)))
        throw new HttpError(422, 'CONTRACT_REPLENISHMENT_PRECISION_REQUIRED', 'Les quantités proposées doivent conserver exactement trois décimales au maximum.');
      if (parseCumpDecimal(month.proposed_quantity) > maximum || parseCumpDecimal(month.lot_quantity) > maximum)
        throw new HttpError(422, 'CONTRACT_REPLENISHMENT_QUANTITY_TOO_LARGE', 'La quantité proposée dépasse le périmètre autorisé. Réduisez l’horizon.');
      return { contract_line_id: line.contract_line_id, article: line.article, month: month.month,
        target_date: month.target_date, target_overdue: month.target_overdue, lot_quantity: month.lot_quantity,
        lot_count: month.lot_count, proposed_quantity: month.proposed_quantity, surplus_quantity: month.surplus_quantity };
    }));
  const fingerprint = createHash('sha256').update(JSON.stringify({ contract_id: report.contract_id,
    contract_version: report.contract_version, snapshot_hash: report.snapshot_hash,
    start_month: report.start_month, months: report.months, as_of_date: today, proposals })).digest('hex');
  return { fingerprint, report, as_of_date: today, proposals };
}
