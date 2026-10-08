import pool from '../../../config/database';
import { resolveCumpStockCosts, type CumpStockCostRow } from '../domain/cump-stock-cost';
import { OF_MARGIN_CUMP_STOCK_SOURCES_SQL } from './cump-stock-cost-sources.sql';

export async function readOfCumpStockCosts(ofId: string) {
  const result = await pool.query<CumpStockCostRow>(OF_MARGIN_CUMP_STOCK_SOURCES_SQL, [ofId]);
  return resolveCumpStockCosts(result.rows, ofId);
}
