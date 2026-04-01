import { z } from "zod";

const uuid = z.string().uuid();

const positiveInt = z.coerce.number().int().positive();

const optionalPositiveInt = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? undefined : value),
  positiveInt.optional()
);

const nullablePositiveInt = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? null : value),
  z.coerce.number().int().positive().nullable()
);

const nullablePositiveNumber = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? null : value),
  z.coerce.number().positive().nullable()
);

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
export const articleCategorySchema = z.enum(["fabrique", "matiere", "traitement", "achat"]);
export type ArticleCategoryDTO = z.infer<typeof articleCategorySchema>;
export const articleBusinessCategorySchema = z.enum([
  "matiere_premiere",
  "traitement_surface",
  "achat_revente",
  "achat_transforme",
  "sous_traitance",
  "piece_finie_fabriquee",
  "fabrique",
  "matiere",
  "traitement",
  "achat",
]);
export const articleWorkflowStatusSchema = z.enum(["EN_DEVIS", "VALIDE"]);
export type ArticleWorkflowStatusDTO = z.infer<typeof articleWorkflowStatusSchema>;

// Mirrors DB enum: public.movement_type
export const stockMovementTypeSchema = z.enum([
  "IN",
  "OUT",
  "TRANSFER",
  "ADJUST",
  "RESERVE",
  "UNRESERVE",
  "DEPRECIATE",
  "ADJUSTMENT",
  "SCRAP",
]);
export type StockMovementTypeDTO = z.infer<typeof stockMovementTypeSchema>;

export const stockMovementStatusSchema = z.enum(["DRAFT", "POSTED", "CANCELLED"]);
export type StockMovementStatusDTO = z.infer<typeof stockMovementStatusSchema>;

export const idParamSchema = z.object({
  params: z.object({ id: uuid }),
});

export const docIdParamSchema = z.object({
  params: z.object({
    id: uuid,
    docId: uuid,
  }),
});

export const listArticlesQuerySchema = z.object({
  q: z.string().trim().optional(),
  article_type: articleTypeSchema.optional(),
  article_category: articleCategorySchema.optional(),
  status: articleWorkflowStatusSchema.optional(),
  projet_id: z.coerce.number().int().positive().optional(),
  family_code: z.string().trim().min(1).max(40).optional(),
  is_active: z.preprocess(parseBoolean, z.boolean().optional()),
  lot_tracking: z.preprocess(parseBoolean, z.boolean().optional()),
  stock_managed: z.preprocess(parseBoolean, z.boolean().optional()),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["updated_at", "created_at", "code", "designation"]).optional().default("updated_at"),
  sortDir: sortDirSchema.optional().default("desc"),
});

export type ListArticlesQueryDTO = z.infer<typeof listArticlesQuerySchema>;

export const listArticleFamiliesQuerySchema = z.object({
  category: articleCategorySchema.optional(),
});
export type ListArticleFamiliesQueryDTO = z.infer<typeof listArticleFamiliesQuerySchema>;

export const listMatiereNuancesQuerySchema = z.object({
  q: z.string().trim().optional(),
  etat_id: optionalPositiveInt,
  is_active: z.preprocess(parseBoolean, z.boolean().optional()),
});
export type ListMatiereNuancesQueryDTO = z.infer<typeof listMatiereNuancesQuerySchema>;

export const createMatiereNuanceSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(40),
      designation: z.string().trim().min(1).max(160),
      densite: nullablePositiveNumber.optional(),
      etat_ids: z.array(positiveInt).optional().default([]),
      is_active: z.boolean().optional().default(true),
    })
    .strict(),
});
export type CreateMatiereNuanceBodyDTO = z.infer<typeof createMatiereNuanceSchema>["body"];

export const listMatiereEtatsQuerySchema = z.object({
  q: z.string().trim().optional(),
  nuance_id: optionalPositiveInt,
  is_active: z.preprocess(parseBoolean, z.boolean().optional()),
});
export type ListMatiereEtatsQueryDTO = z.infer<typeof listMatiereEtatsQuerySchema>;

export const createMatiereEtatSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(40),
      designation: z.string().trim().min(1).max(160),
      unite_achat: optionalPositiveInt,
      nuance_ids: z.array(positiveInt).optional().default([]),
      is_active: z.boolean().optional().default(true),
    })
    .strict(),
});
export type CreateMatiereEtatBodyDTO = z.infer<typeof createMatiereEtatSchema>["body"];

export const listMatiereSousEtatsQuerySchema = z.object({
  q: z.string().trim().optional(),
  etat_id: optionalPositiveInt,
  is_active: z.preprocess(parseBoolean, z.boolean().optional()),
});
export type ListMatiereSousEtatsQueryDTO = z.infer<typeof listMatiereSousEtatsQuerySchema>;

export const createMatiereSousEtatSchema = z.object({
  body: z
    .object({
      etat_id: positiveInt,
      code: z.string().trim().min(1).max(40),
      designation: z.string().trim().min(1).max(160),
      is_active: z.boolean().optional().default(true),
    })
    .strict(),
});
export type CreateMatiereSousEtatBodyDTO = z.infer<typeof createMatiereSousEtatSchema>["body"];

export const createArticleFamilySchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(40),
      designation: z.string().trim().min(1).max(160),
      category: articleCategorySchema,
    })
    .strict(),
});
export type CreateArticleFamilyBodyDTO = z.infer<typeof createArticleFamilySchema>["body"];

export const createArticleSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(80),
      designation: z.string().trim().min(1).max(400),
      article_type: articleTypeSchema.optional(),
      article_category: articleCategorySchema.optional().default("achat"),
      article_categories: z.array(articleBusinessCategorySchema).min(1).max(8).optional(),
      family_code: z.string().trim().min(1).max(40),
      version_number: z.coerce.number().int().positive().optional(),
      plan_index: z.coerce.number().int().positive().optional().default(1),
      status: articleWorkflowStatusSchema.optional().default("VALIDE"),
      projet_id: z.coerce.number().int().positive().optional().nullable(),
      stock_managed: z.boolean().optional().default(true),
      piece_technique_id: uuid.optional().nullable(),
      unite: z.string().trim().min(1).max(30).optional().nullable(),
      lot_tracking: z.boolean().optional().default(false),
      is_active: z.boolean().optional().default(true),
      notes: z.string().trim().min(1).optional().nullable(),
      article_matiere: z
        .object({
          nuance_id: nullablePositiveInt.optional(),
          etat_id: nullablePositiveInt.optional(),
          sous_etat_id: nullablePositiveInt.optional(),
          barre_a_decouper: z.boolean().optional().default(false),
          longueur_mm: nullablePositiveInt.optional(),
          longueur_unitaire_mm: nullablePositiveInt.optional(),
          largeur_mm: nullablePositiveInt.optional(),
          hauteur_mm: nullablePositiveInt.optional(),
          epaisseur_mm: nullablePositiveInt.optional(),
          diametre_mm: nullablePositiveInt.optional(),
          largeur_plat_mm: nullablePositiveInt.optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .superRefine((body, ctx) => {
      if (body.article_category === "fabrique") {
        if (!body.piece_technique_id) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "piece_technique_id is required for fabricated articles", path: ["piece_technique_id"] });
        }
        if (!body.projet_id) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "projet_id is required for fabricated articles", path: ["projet_id"] });
        }
      }
      if (body.article_category !== "fabrique" && body.piece_technique_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Only fabricated articles may reference a piece technique", path: ["piece_technique_id"] });
      }
      if (!body.stock_managed && body.lot_tracking) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "lot_tracking requires stock_managed=true", path: ["lot_tracking"] });
      }

      if (body.article_matiere && body.article_category !== "matiere") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "article_matiere is only allowed for article_category=matiere",
          path: ["article_matiere"],
        });
      }
    }),
});

export type CreateArticleBodyDTO = z.infer<typeof createArticleSchema>["body"];

export const updateArticleSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(80).optional(),
      designation: z.string().trim().min(1).max(400).optional(),
      article_type: articleTypeSchema.optional(),
      article_category: articleCategorySchema.optional(),
      article_categories: z.array(articleBusinessCategorySchema).min(1).max(8).optional(),
      family_code: z.string().trim().min(1).max(40).optional(),
      version_number: z.coerce.number().int().positive().optional(),
      plan_index: z.coerce.number().int().positive().optional(),
      status: articleWorkflowStatusSchema.optional(),
      projet_id: z.coerce.number().int().positive().optional().nullable(),
      stock_managed: z.boolean().optional(),
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
  params: z.object({ magasinId: uuid }),
});

export const emplacementIdParamSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

export const listEmplacementsQuerySchema = z.object({
  q: z.string().trim().optional(),
  magasin_id: uuid.optional(),
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
  article_id: uuid.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortBy: z.enum(["updated_at", "created_at", "lot_code", "received_at"]).optional().default("updated_at"),
  sortDir: sortDirSchema.optional().default("desc"),
});

export type ListLotsQueryDTO = z.infer<typeof listLotsQuerySchema>;

export const createLotSchema = z.object({
  body: z
    .object({
      article_id: uuid,
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
  article_id: uuid.optional(),
  magasin_id: uuid.optional(),
  emplacement_id: z.coerce.number().int().positive().optional(),
  lot_id: uuid.optional(),
  warehouse_id: uuid.optional(),
  location_id: uuid.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(100),
});

export type ListBalancesQueryDTO = z.infer<typeof listBalancesQuerySchema>;

export const listAnalyticsQuerySchema = z.object({
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  magasin_id: uuid.optional(),
});

export type ListAnalyticsQueryDTO = z.infer<typeof listAnalyticsQuerySchema>;

export const listMovementsQuerySchema = z.object({
  q: z.string().trim().optional(),
  movement_type: stockMovementTypeSchema.optional(),
  status: stockMovementStatusSchema.optional(),
  article_id: uuid.optional(),
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
    article_id: uuid,
    lot_id: uuid.optional().nullable(),
    qty: z.coerce.number().positive(),
    unite: z.string().trim().min(1).max(30).optional().nullable(),
    unit_cost: z.coerce.number().min(0).optional().nullable(),
    currency: z.string().trim().min(1).max(10).optional().nullable(),
    src_magasin_id: uuid.optional().nullable(),
    src_emplacement_id: z.coerce.number().int().positive().optional().nullable(),
    dst_magasin_id: uuid.optional().nullable(),
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
        case "RESERVE":
        case "UNRESERVE":
        case "DEPRECIATE":
        case "SCRAP":
          if (!srcOk) addIssue(`${body.movement_type} line requires src_magasin_id and src_emplacement_id`);
          break;
        case "ADJUST":
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

    // DB model is per-article movement; keep lines on a single article.
    const first = body.lines[0]?.article_id;
    if (first) {
      for (let i = 1; i < body.lines.length; i++) {
        if (body.lines[i]?.article_id !== first) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "All movement lines must have the same article_id",
            path: ["lines", i, "article_id"],
          });
        }
      }
    }
  });

export const createMovementSchema = z.object({
  body: createMovementBodySchema,
});

export type CreateMovementBodyDTO = z.infer<typeof createMovementSchema>["body"];

export const stockInventorySessionStatusSchema = z.enum(["OPEN", "CLOSED"]);
export type StockInventorySessionStatusDTO = z.infer<typeof stockInventorySessionStatusSchema>;

export const listInventorySessionsQuerySchema = z.object({
  q: z.string().trim().optional(),
  status: stockInventorySessionStatusSchema.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortBy: z.enum(["started_at", "created_at", "updated_at", "session_no"]).optional().default("started_at"),
  sortDir: sortDirSchema.optional().default("desc"),
});

export type ListInventorySessionsQueryDTO = z.infer<typeof listInventorySessionsQuerySchema>;

export const createInventorySessionSchema = z.object({
  body: z
    .object({
      notes: z.string().trim().min(1).optional().nullable(),
    })
    .strict(),
});

export type CreateInventorySessionBodyDTO = z.infer<typeof createInventorySessionSchema>["body"];

export const upsertInventoryLineSchema = z.object({
  body: z
    .object({
      article_id: uuid,
      magasin_id: uuid,
      emplacement_id: z.coerce.number().int().positive(),
      lot_id: uuid.optional().nullable(),
      counted_qty: z.coerce.number().min(0),
      note: z.string().trim().min(1).optional().nullable(),
    })
    .strict(),
});

export type UpsertInventoryLineBodyDTO = z.infer<typeof upsertInventoryLineSchema>["body"];
