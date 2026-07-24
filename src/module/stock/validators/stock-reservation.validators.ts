import { z } from "zod";

const uuid = z.string().uuid();

export const stockReservationStatusSchema = z.enum([
  "ACTIVE",
  "RELEASED",
  "CONSUMED",
  "EXPIRED",
  "CANCELLED",
]);

export const stockReservationSourceSchema = z.discriminatedUnion("source_type", [
  z
    .object({
      source_type: z.literal("COMMANDE_LIGNE"),
      commande_ligne_id: z.coerce.number().int().positive(),
    })
    .strict(),
  z
    .object({
      source_type: z.literal("OF"),
      of_id: z.coerce.number().int().positive(),
    })
    .strict(),
  z
    .object({
      source_type: z.literal("BON_LIVRAISON_LIGNE"),
      bon_livraison_ligne_id: uuid,
    })
    .strict(),
  z
    .object({
      source_type: z.literal("AFFAIRE"),
      affaire_id: z.coerce.number().int().positive(),
    })
    .strict(),
]);

export const listStockReservationsQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    article_id: uuid.optional(),
    magasin_id: uuid.optional(),
    emplacement_id: z.coerce.number().int().positive().optional(),
    lot_id: uuid.optional(),
    status: stockReservationStatusSchema.optional(),
    source_type: z
      .enum(["COMMANDE_LIGNE", "OF", "BON_LIVRAISON_LIGNE", "AFFAIRE"])
      .optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
    sortBy: z
      .enum(["created_at", "updated_at", "expires_at", "qty_reserved"])
      .optional()
      .default("created_at"),
    sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
  })
  .strict();

export const createStockReservationSchema = z.object({
  body: z
    .object({
      article_id: uuid,
      magasin_id: uuid,
      emplacement_id: z.coerce.number().int().positive(),
      lot_id: uuid.optional().nullable(),
      qty: z.coerce.number().positive().max(1_000_000_000),
      source: stockReservationSourceSchema,
      reason: z.string().trim().min(3).max(500),
      expires_at: z.string().datetime({ offset: true }).optional().nullable(),
    })
    .strict(),
});

export const stockReservationActionSchema = z.object({
  body: z
    .object({
      expected_version: z.coerce.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
    })
    .strict(),
});

export const consumeStockReservationSchema = z.object({
  body: z
    .object({
      expected_version: z.coerce.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
      stock_movement_id: uuid,
    })
    .strict(),
});

export type ListStockReservationsQueryDTO = z.infer<typeof listStockReservationsQuerySchema>;
export type CreateStockReservationBodyDTO = z.infer<typeof createStockReservationSchema>["body"];
export type StockReservationActionBodyDTO = z.infer<typeof stockReservationActionSchema>["body"];
export type ConsumeStockReservationBodyDTO = z.infer<typeof consumeStockReservationSchema>["body"];
