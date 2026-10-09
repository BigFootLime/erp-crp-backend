import { createHash } from 'node:crypto';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { readCrmClient } from '../repository/client-crm.repository';
import { readClientContract } from '../repository/client-contract.repository';
import { CONTRACT_COVERAGE_PERIODS_SQL, readContractCoverageDemands } from '../repository/client-contract-coverage.repository';
import { readContractCoverageStock } from '../repository/client-contract-coverage-stock.repository';
import { readContractCoverageProduction } from '../repository/client-contract-coverage-production.repository';
import { allocateContractCoverage, projectContractCoverageMonths } from '../domain/client-contract-coverage';
import type { ClientContractCoverageQuery } from '../validators/client-contract-coverage.validators';
import type { ContractCoverageResult, CoveragePeriod } from '../types/client-contract-coverage.types';

export async function getClientContractCoverage(clientId: string, contractId: string, query: ClientContractCoverageQuery): Promise<ContractCoverageResult> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const clock = (await tx.query<{ now: string; today: string; month: string }>(`SELECT now()::text AS now,
      (now() AT TIME ZONE 'Europe/Paris')::date::text AS today,to_char(now() AT TIME ZONE 'Europe/Paris','YYYY-MM') AS month`)).rows[0];
    const client = await readCrmClient(tx, clientId);
    if (!client) throw new HttpError(404, 'CLIENT_NOT_FOUND', 'Client introuvable.');
    const contract = await readClientContract(tx, clientId, contractId);
    if (!contract) throw new HttpError(404, 'CLIENT_CONTRACT_NOT_FOUND', 'Contrat introuvable pour ce client.');
    if (contract.status !== 'ACTIVE') throw new HttpError(409, 'CONTRACT_COVERAGE_CONTRACT_INACTIVE', 'Activez le contrat avant de calculer ses besoins.');
    if (contract.lines.some(line => !line.proposed_article))
      throw new HttpError(409, 'CONTRACT_COVERAGE_ARTICLE_REQUIRED', 'Validez la définition technique de chaque article du contrat avant de calculer.');
    const articles = contract.lines.map(line => line.proposed_article!);
    const start = query.start_month ?? clock.month;
    const periods = (await tx.query<CoveragePeriod>(CONTRACT_COVERAGE_PERIODS_SQL, [start + '-01', query.months])).rows;
    const demandSource = await readContractCoverageDemands(tx, articles, periods);
    const stock = await readContractCoverageStock(tx, articles.map(article => article.article_id));
    const production = await readContractCoverageProduction(tx, { articleIds: articles.map(article => article.article_id),
      now: new Date(clock.now).toISOString(), endDate: periods.at(-1)!.end_date });
    const allSources = [...stock.sources, ...production.sources];
    if (allSources.length > 10000) throw new HttpError(422, 'CONTRACT_COVERAGE_SCOPE_TOO_LARGE', 'La synthèse dépasse 10 000 sources de couverture.');
    const allDemands = demandSource.demands.map(demand => ({ ...demand, unit: demand.unit.trim().toUpperCase() }));
    const allAllocations = allocateContractCoverage(allDemands, allSources);
    const demands = allDemands.filter(demand => demand.contract_id === contractId);
    const selected = new Set(demands.map(demand => demand.id));
    const allocations = allAllocations.filter(allocation => selected.has(allocation.demand_id));
    const sourceIds = new Set(allocations.map(allocation => allocation.source_id));
    const sources = allSources.filter(source => sourceIds.has(source.id));
    const lines = contract.lines.map(line => ({ contract_line_id: line.id, replenishment_qty: line.replenishment_qty,
      article: line.proposed_article!, months: projectContractCoverageMonths({ periods, today: clock.today,
        demands: demands.filter(demand => demand.contract_line_id === line.id), allocations }) }));
    const lateProduction = allSources.some(source => source.kind === 'PRODUCTION' && source.available_date &&
      demands.some(demand => source.order_line_id !== null && source.order_line_id === demand.order_line_id &&
        source.available_date! > demand.target_date));
    const issues = [...new Map([...stock.issues, ...production.issues,
      ...(lateProduction ? [{ code: 'LATE_COMMITTED_PRODUCTION', message: 'Un OF engagé termine après une échéance : sa quantité tardive ne garantit pas une livraison à temps.' }] : [])]
      .map(issue => [issue.code, issue])).values()];
    const snapshotHash = createHash('sha256').update(JSON.stringify({ contract, periods,
      allDemands, allSources, allAllocations, issues, planning_revision: production.revision })).digest('hex');
    await tx.query('COMMIT');
    return { contract_id: contractId, contract_version: contract.version, generated_at: new Date(clock.now).toISOString(),
      planning_revision: production.revision, start_month: start, months: query.months, readonly: true,
      snapshot_hash: snapshotHash, lines, demands, sources, allocations, issues };
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}
