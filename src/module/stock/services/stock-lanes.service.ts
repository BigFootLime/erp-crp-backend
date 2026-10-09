import pool from "../../../config/database";
import { STOCK_LANES, STOCK_LANE_LABELS } from "../domain/stock-lanes";
import { readStockLaneLocationsTx, readStockLanePositionsTx, configureStockLane } from "../repository/stock-lanes.repository";
import type { StockLanePositionsQuery, StockLaneConfigurationCommand } from "../validators/stock-lanes.validators";

export async function getStockLaneLocations() {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const locations = await readStockLaneLocationsTx(tx);
    const as_of = (await tx.query<{ as_of: string }>("SELECT transaction_timestamp()::text AS as_of")).rows[0].as_of;
    await tx.query("COMMIT");
    return { as_of, locations, lanes: STOCK_LANES.map(value => ({ value, label: STOCK_LANE_LABELS[value],
      configured_locations: locations.filter(location => location.lane === value).length,
      usable_locations: locations.filter(location => location.lane === value && location.facts.active
        && location.facts.mapped && location.facts.storage && location.facts.inbound && location.facts.outbound).length })),
      routing_active: false as const };
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}

export async function getStockLanePositions(query: StockLanePositionsQuery) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await readStockLanePositionsTx(tx, query);
    const as_of = (await tx.query<{ as_of: string }>("SELECT transaction_timestamp()::text AS as_of")).rows[0].as_of;
    await tx.query("COMMIT");
    return { ...result, as_of, routing_active: false as const,
      availability_scope: "PHYSICAL_LOT_STATUS_ONLY" as const };
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}

export function setStockLaneLocation(locationId: string, command: StockLaneConfigurationCommand, actor: number) {
  return configureStockLane(locationId, command, actor);
}
