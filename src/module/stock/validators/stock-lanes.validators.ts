import { z } from "zod";
import { STOCK_LANES } from "../domain/stock-lanes";

export const stockLaneLocationParams = z.object({ locationId: z.string().uuid() }).strict();
export const stockLaneConfigurationCommand = z.object({
  lane: z.enum(STOCK_LANES),
  default_destination: z.boolean().optional(),
  expected_version: z.number().int().min(0).max(2147483647),
  request_id: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
}).strict();
export const stockLanePositionsQuery = z.object({
  lane: z.enum([...STOCK_LANES, "UNASSIGNED"]).optional(),
  article_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  q: z.string().trim().max(160).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export type StockLaneConfigurationCommand = z.infer<typeof stockLaneConfigurationCommand>;
export type StockLanePositionsQuery = z.infer<typeof stockLanePositionsQuery>;
