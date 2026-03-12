import { z } from "zod";

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

export const notificationIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const listNotificationsQuerySchema = z.object({
  unread_only: z.preprocess(parseBoolean, z.boolean().optional()).default(false),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type ListNotificationsQueryDTO = z.infer<typeof listNotificationsQuerySchema>;
