import { z } from "zod";

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

export const sortDirSchema = z.enum(["asc", "desc"]);

export const articleTypeSchema = z.enum(["PIECE_TECHNIQUE", "PURCHASED"]);
export type ArticleTypeDTO = z.infer<typeof articleTypeSchema>;

export const stockMovementTypeSchema = z.enum(["IN", "OUT", "TRANSFER", "ADJUSTMENT", "SCRAP"]);
export type StockMovementTypeDTO = z.infer<typeof stockMovementTypeSchema>;

export const stockMovementStatusSchema = z.enum(["DRAFT", "POSTED", "CANCELLED"]);
export type StockMovementStatusDTO = z.infer<typeof stockMovementStatusSchema>;

export const idParamSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

export const docIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
    docId: uuid,
  }),
});

export const listArticlesQuerySchema = z.object({
  q: z.string().trim().optional(),
  article_type: articleTypeSchema.optional(),
  is_active: z.preprocess(parseBoolean, z.boolean().optional()),
  lot_tracking: z.preprocess(parseBoolean, z.boolean().optional()),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["updated_at", "created_at", "code", "designation"]).optional().default("updated_at"),
  sortDir: sortDirSchema.optional().default("desc"),
});

export type ListArticlesQueryDTO = z.infer<typeof listArticlesQuerySchema>;

export const createArticleSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(80),
      designation: z.string().trim().min(1).max(400),
      article_type: articleTypeSchema.optional().default("PURCHASED"),
      piece_technique_id: uuid.optional().nullable(),
      unite: z.string().trim().min(1).max(30).optional().nullable(),
      lot_tracking: z.boolean().optional().default(false),
      is_active: z.boolean().optional().default(true),
      notes: z.string().trim().min(1).optional().nullable(),
    })
    .strict(),
});

export type CreateArticleBodyDTO = z.infer<typeof createArticleSchema>["body"];

export const updateArticleSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(80).optional(),
      designation: z.string().trim().min(1).max(400).optional(),
      article_type: articleTypeSchema.optional(),
      piece_technique_id: uuid.optional().nullable(),
      unite: z.string().trim().min(1).max(30).optional().nullable(),
      lot_tracking: z.boolean().optional(),
      is_active: z.boolean().optional(),
      notes: z.string().trim().min(1).optional().nullable(),
    })
    .strict(),
});

export type UpdateArticleBodyDTO = z.infer<typeof updateArticleSchema>["body"];

export const listMagasinsQuerySchema = z.object({
  q: z.string().trim().optional(),
  is_active: z.preprocess(parseBoolean, z.boolean().optional()),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["updated_at", "created_at", "code", "name"]).optional().default("updated_at"),
  sortDir: sortDirSchema.optional().default("desc"),
});

export type ListMagasinsQueryDTO = z.infer<typeof listMagasinsQuerySchema>;

export const createMagasinSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(40),
      name: z.string().trim().min(1).max(200),
      is_active: z.boolean().optional().default(true),
      notes: z.string().trim().min(1).optional().nullable(),
    })
    .strict(),
});

export type CreateMagasinBodyDTO = z.infer<typeof createMagasinSchema>["body"];

export const updateMagasinSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(40).optional(),
      name: z.string().trim().min(1).max(200).optional(),
      is_active: z.boolean().optional(),
      notes: z.string().trim().min(1).optional().nullable(),
    })
    .strict(),
});

export type UpdateMagasinBodyDTO = z.infer<typeof updateMagasinSchema>["body"];

export const magasinIdParamSchema = z.object({
  params: z.object({ magasinId: z.coerce.number().int().positive() }),
});

export const listEmplacementsQuerySchema = z.object({
  q: z.string().trim().optional(),
  magasin_id: z.coerce.number().int().positive().optional(),
  is_active: z.preprocess(parseBoolean, z.boolean().optional()),
  is_scrap: z.preprocess(parseBoolean, z.boolean().optional()),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortBy: z.enum(["updated_at", "created_at", "code"]).optional().default("updated_at"),
  sortDir: sortDirSchema.optional().default("desc"),
});

export type ListEmplacementsQueryDTO = z.infer<typeof listEmplacementsQuerySchema>;

export const createEmplacementSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(40),
      name: z.string().trim().min(1).max(200).optional().nullable(),
      is_scrap: z.boolean().optional().default(false),
      is_active: z.boolean().optional().default(true),
      notes: z.string().trim().min(1).optional().nullable(),
    })
    .strict(),
});

export type CreateEmplacementBodyDTO = z.infer<typeof createEmplacementSchema>["body"];

export const updateEmplacementSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(40).optional(),
      name: z.string().trim().min(1).max(200).optional().nullable(),
      is_scrap: z.boolean().optional(),
      is_active: z.boolean().optional(),
      notes: z.string().trim().min(1).optional().nullable(),
    })
    .strict(),
});

export type UpdateEmplacementBodyDTO = z.infer<typeof updateEmplacementSchema>["body"];

export const listLotsQuerySchema = z.object({
  q: z.string().trim().optional(),
  article_id: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortBy: z.enum(["updated_at", "created_at", "lot_code", "received_at"]).optional().default("updated_at"),
  sortDir: sortDirSchema.optional().default("desc"),
});

export type ListLotsQueryDTO = z.infer<typeof listLotsQuerySchema>;

export const createLotSchema = z.object({
  body: z
    .object({
      article_id: z.coerce.number().int().positive(),
      lot_code: z.string().trim().min(1).max(80),
      supplier_lot_code: z.string().trim().min(1).max(120).optional().nullable(),
      received_at: z.string().trim().optional().nullable(),
      manufactured_at: z.string().trim().optional().nullable(),
      expiry_at: z.string().trim().optional().nullable(),
      notes: z.string().trim().min(1).optional().nullable(),
    })
    .strict(),
});

export type CreateLotBodyDTO = z.infer<typeof createLotSchema>["body"];

export const updateLotSchema = z.object({
  body: z
    .object({
      lot_code: z.string().trim().min(1).max(80).optional(),
      supplier_lot_code: z.string().trim().min(1).max(120).optional().nullable(),
      received_at: z.string().trim().optional().nullable(),
      manufactured_at: z.string().trim().optional().nullable(),
      expiry_at: z.string().trim().optional().nullable(),
      notes: z.string().trim().min(1).optional().nullable(),
    })
    .strict(),
});

export type UpdateLotBodyDTO = z.infer<typeof updateLotSchema>["body"];

export const listBalancesQuerySchema = z.object({
  article_id: z.coerce.number().int().positive().optional(),
  magasin_id: z.coerce.number().int().positive().optional(),
  emplacement_id: z.coerce.number().int().positive().optional(),
  lot_id: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(100),
});

export type ListBalancesQueryDTO = z.infer<typeof listBalancesQuerySchema>;

export const listMovementsQuerySchema = z.object({
  q: z.string().trim().optional(),
  movement_type: stockMovementTypeSchema.optional(),
  status: stockMovementStatusSchema.optional(),
  article_id: z.coerce.number().int().positive().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortBy: z.enum(["updated_at", "created_at", "effective_at", "posted_at", "movement_no", "id"]).optional().default("effective_at"),
  sortDir: sortDirSchema.optional().default("desc"),
});

export type ListMovementsQueryDTO = z.infer<typeof listMovementsQuerySchema>;

export const createMovementLineSchema = z
  .object({
    line_no: z.coerce.number().int().min(1).optional(),
    article_id: z.coerce.number().int().positive(),
    lot_id: z.coerce.number().int().positive().optional().nullable(),
    qty: z.coerce.number().positive(),
    unite: z.string().trim().min(1).max(30).optional().nullable(),
    unit_cost: z.coerce.number().min(0).optional().nullable(),
    currency: z.string().trim().min(1).max(10).optional().nullable(),
    src_magasin_id: z.coerce.number().int().positive().optional().nullable(),
    src_emplacement_id: z.coerce.number().int().positive().optional().nullable(),
    dst_magasin_id: z.coerce.number().int().positive().optional().nullable(),
    dst_emplacement_id: z.coerce.number().int().positive().optional().nullable(),
    note: z.string().trim().min(1).optional().nullable(),
    direction: z.enum(["IN", "OUT"]).optional(),
  })
  .strict();

export type CreateMovementLineDTO = z.infer<typeof createMovementLineSchema>;

const createMovementBodySchema = z
  .object({
    movement_type: stockMovementTypeSchema,
    effective_at: z.string().trim().optional().nullable(),
    source_document_type: z.string().trim().min(1).max(80).optional().nullable(),
    source_document_id: z.string().trim().min(1).max(120).optional().nullable(),
    reason_code: z.string().trim().min(1).max(80).optional().nullable(),
    notes: z.string().trim().min(1).optional().nullable(),
    idempotency_key: z.string().trim().min(1).max(200).optional().nullable(),
    lines: z.array(createMovementLineSchema).min(1),
  })
  .strict()
  .superRefine((body, ctx) => {
    for (let i = 0; i < body.lines.length; i++) {
      const line = body.lines[i];
      const srcOk = !!(line.src_magasin_id && line.src_emplacement_id);
      const dstOk = !!(line.dst_magasin_id && line.dst_emplacement_id);

      const addIssue = (message: string) => {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message,
          path: ["lines", i],
        });
      };

      switch (body.movement_type) {
        case "IN":
          if (!dstOk) addIssue("IN line requires dst_magasin_id and dst_emplacement_id");
          break;
        case "OUT":
          if (!srcOk) addIssue("OUT line requires src_magasin_id and src_emplacement_id");
          break;
        case "TRANSFER":
          if (!srcOk || !dstOk) addIssue("TRANSFER line requires both src_* and dst_* location fields");
          break;
        case "SCRAP":
          if (!srcOk) addIssue("SCRAP line requires src_magasin_id and src_emplacement_id");
          break;
        case "ADJUSTMENT":
          if (line.direction !== "IN" && line.direction !== "OUT") {
            addIssue("ADJUSTMENT line requires direction IN or OUT");
            break;
          }
          if (line.direction === "IN" && !dstOk) addIssue("ADJUSTMENT IN line requires dst_* location fields");
          if (line.direction === "OUT" && !srcOk) addIssue("ADJUSTMENT OUT line requires src_* location fields");
          break;
      }
    }
  });

export const createMovementSchema = z.object({
  body: createMovementBodySchema,
});

export type CreateMovementBodyDTO = z.infer<typeof createMovementSchema>["body"];
