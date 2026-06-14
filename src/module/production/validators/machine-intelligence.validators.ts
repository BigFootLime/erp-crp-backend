import { z } from "zod";
import { machineTypeSchema } from "./production.validators";

const uuid = z.string().uuid();

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "y") return true;
  if (v === "false" || v === "0" || v === "no" || v === "n") return false;
  return undefined;
}

export const machineModelIdParamSchema = z.object({
  params: z.object({ id: uuid }),
});

export const listMachineModelsQuerySchema = z.object({
  q: z.string().trim().optional(),
  manufacturer: z.string().trim().min(1).optional(),
  machine_type: machineTypeSchema.optional(),
  include_inactive: z.preprocess(parseBoolean, z.boolean().optional()).default(false),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["updated_at", "manufacturer", "model", "display_name"]).optional().default("manufacturer"),
  sortDir: z.enum(["asc", "desc"]).optional().default("asc"),
});

export type ListMachineModelsQueryDTO = z.infer<typeof listMachineModelsQuerySchema>;
