import type { PoolClient } from "pg";
import { STOCK_LANES, type StockLane } from "../domain/stock-lanes";
import { HttpError } from "../../../utils/httpError";

export type StockLaneDestination = {
  lane: StockLane; location_id: string; magasin_id: string; emplacement_id: number; valid: boolean;
  magasin_code: string; emplacement_code: string;
};

/** Call before locking a receipt's stock. Topology changes use the exclusive counterpart. */
export async function lockStockLaneTopology(tx: Pick<PoolClient, "query">): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('stock-lane-topology',0))");
}

export async function readStockLaneRoutingTx(tx: Pick<PoolClient, "query">) {
  const destinations = (await tx.query<StockLaneDestination>(`SELECT destination.lane,destination.location_id::text,
    e.magasin_id::text,e.id::int AS emplacement_id,m.code AS magasin_code,e.code AS emplacement_code,
    (role.lane=destination.lane AND e.is_active AND m.is_active AND e.location_type='STORAGE'
      AND NOT e.is_scrap AND e.allow_inbound AND e.allow_outbound AND location.warehouse_id IS NOT NULL) AS valid
    FROM public.stock_lane_destinations destination
    JOIN public.locations location ON location.id=destination.location_id
    JOIN public.emplacements e ON e.location_id=destination.location_id
    JOIN public.magasins m ON m.id=e.magasin_id
    LEFT JOIN public.stock_lane_locations role ON role.location_id=destination.location_id ORDER BY destination.lane`)).rows;
  const complete = STOCK_LANES.every(lane => destinations.some(destination => destination.lane === lane));
  const active = complete && destinations.every(destination => destination.valid);
  return { destinations, routing_active: active, routing_status: complete ? (active ? "ACTIVE" : "INVALID") : "CONFIGURING" } as const;
}

export async function getActiveStockLaneDestinationsTx(tx: Pick<PoolClient, "query">) {
  const state = await readStockLaneRoutingTx(tx);
  if (state.routing_status === "INVALID")
    throw new HttpError(409, "STOCK_LANE_DESTINATION_UNAVAILABLE", "Une piste de réception est inactive ou incompatible. Corrigez son emplacement.");
  return state.routing_active ? state.destinations : null;
}
