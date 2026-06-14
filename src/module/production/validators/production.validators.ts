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

export const machineTypeSchema = z.enum(["MILLING", "TURNING", "EDM", "GRINDING", "OTHER"]);
export type MachineTypeDTO = z.infer<typeof machineTypeSchema>;

export const machineStatusSchema = z.enum(["ACTIVE", "IN_MAINTENANCE", "OUT_OF_SERVICE"]);
export type MachineStatusDTO = z.infer<typeof machineStatusSchema>;

export const machineIdParamSchema = z.object({
  params: z.object({ id: uuid }),
});

export const listMachinesQuerySchema = z.object({
  q: z.string().optional(),
  type: machineTypeSchema.optional(),
  status: machineStatusSchema.optional(),
  is_available: z.preprocess(parseBoolean, z.boolean().optional()),
  include_archived: z.preprocess(parseBoolean, z.boolean().optional()).default(false),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["updated_at", "created_at", "code", "name"]).optional().default("updated_at"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type ListMachinesQueryDTO = z.infer<typeof listMachinesQuerySchema>;

const currencySchema = z.string().trim().min(1).max(10).optional().default("EUR");
const currencyPatchSchema = z.string().trim().min(1).max(10).optional();
const optionalUrlSchema = z.string().trim().url().max(1000).optional().nullable();
const optionalPathSchema = z.string().trim().min(1).max(1000).optional().nullable();
const optionalYearSchema = z.coerce.number().int().min(1950).max(2100).optional().nullable();
const optionalPositiveIntSchema = z.coerce.number().int().positive().optional().nullable();
const optionalPositiveNumberSchema = z.coerce.number().positive().optional().nullable();
const optionalNonNegativeNumberSchema = z.coerce.number().min(0).optional().nullable();
const optionalShortTextSchema = z.string().trim().min(1).max(120).optional().nullable();
const optionalMediumTextSchema = z.string().trim().min(1).max(500).optional().nullable();
const onboardingTextArraySchema = z.array(z.string().trim().min(1).max(120)).max(50).optional().default([]);
const sourceConfidenceSchema = z.enum(["official", "resale_listing", "estimated", "internal", "unknown"]);
const sourceTypeSchema = z.enum(["manufacturer_page", "manufacturer_pdf", "resale_listing", "internal_note", "mixed", "unknown"]);
const capabilityLevelSchema = z.enum(["preferred", "primary", "supported", "limited", "unknown"]);

export const createMachineSchema = z.object({
  body: z.object({
    code: z.string().trim().min(1).max(50),
    name: z.string().trim().min(1).max(200),
    type: machineTypeSchema.optional().default("OTHER"),
    machine_model_id: uuid.optional().nullable(),
    display_name: z.string().trim().min(1).max(200).optional().nullable(),
    brand: z.string().trim().min(1).max(120).optional().nullable(),
    model: z.string().trim().min(1).max(120).optional().nullable(),
    serial_number: z.string().trim().min(1).max(120).optional().nullable(),
    commissioned_year: optionalYearSchema,
    hourly_rate: z.coerce.number().min(0).optional().default(0),
    currency: currencySchema,
    status: machineStatusSchema.optional().default("ACTIVE"),
    is_available: z.boolean().optional().default(true),
    dashboard_color: z.string().trim().min(1).max(40).optional().nullable(),
    model_3d_path: optionalPathSchema,
    documentation_url: optionalUrlSchema,
    documentation_source: z.string().trim().min(1).max(120).optional().nullable(),
    scheduling_enabled: z.boolean().optional().default(true),
    outillage_enabled: z.boolean().optional().default(true),
    location: z.string().trim().min(1).max(200).optional().nullable(),
    workshop_zone: z.string().trim().min(1).max(200).optional().nullable(),
    notes: z.string().trim().min(1).optional().nullable(),
  }),
});

export type CreateMachineBodyDTO = z.infer<typeof createMachineSchema>["body"];

export const createMachineOnboardingSchema = z.object({
  body: z.object({
    machine: createMachineSchema.shape.body,
    machine_model: z
      .object({
        id: uuid.optional().nullable(),
        model_code: z.string().trim().min(1).max(120).optional().nullable(),
        manufacturer: optionalShortTextSchema,
        model: optionalShortTextSchema,
        display_name: z.string().trim().min(1).max(200).optional().nullable(),
        machine_type: machineTypeSchema.optional(),
        axes_count: optionalPositiveIntSchema,
        description: z.string().trim().min(1).max(2000).optional().nullable(),
        source_summary: z.string().trim().min(1).max(2000).optional().nullable(),
        is_active: z.boolean().optional().default(true),
      })
      .optional()
      .nullable(),
    specs: z
      .object({
        x_travel_mm: optionalPositiveNumberSchema,
        y_travel_mm: optionalPositiveNumberSchema,
        z_travel_mm: optionalPositiveNumberSchema,
        table_length_mm: optionalPositiveNumberSchema,
        table_width_mm: optionalPositiveNumberSchema,
        max_table_load_kg: optionalPositiveNumberSchema,
        spindle_taper: optionalShortTextSchema,
        spindle_speed_max_rpm: optionalPositiveIntSchema,
        spindle_power_kw: optionalPositiveNumberSchema,
        tool_magazine_capacity: optionalPositiveIntSchema,
        compatible_holders: onboardingTextArraySchema,
        operations_notes: optionalMediumTextSchema,
        maintenance_notes: optionalMediumTextSchema,
        source_type: sourceTypeSchema.optional().default("internal_note"),
        source_confidence: sourceConfidenceSchema.optional().default("internal"),
        source_notes: optionalMediumTextSchema,
      })
      .optional()
      .nullable(),
    capabilities: z
      .array(
        z.object({
          process_type: z.string().trim().min(1).max(120),
          material_family: optionalShortTextSchema,
          capability_level: capabilityLevelSchema.optional().default("supported"),
          notes: optionalMediumTextSchema,
          source_confidence: sourceConfidenceSchema.optional().default("internal"),
        })
      )
      .max(80)
      .optional()
      .default([]),
    tooling: z
      .array(
        z.object({
          holder_type: z.string().trim().min(1).max(120),
          spindle_taper: optionalShortTextSchema,
          tool_family: optionalShortTextSchema,
          compatible: z.boolean().optional().default(true),
          notes: optionalMediumTextSchema,
          source_confidence: sourceConfidenceSchema.optional().default("internal"),
        })
      )
      .max(80)
      .optional()
      .default([]),
  }),
});

export type CreateMachineOnboardingBodyDTO = z.infer<typeof createMachineOnboardingSchema>["body"];

export const updateMachineSchema = z.object({
  body: z.object({
    code: z.string().trim().min(1).max(50).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    type: machineTypeSchema.optional(),
    machine_model_id: uuid.optional().nullable(),
    display_name: z.string().trim().min(1).max(200).optional().nullable(),
    brand: z.string().trim().min(1).max(120).optional().nullable(),
    model: z.string().trim().min(1).max(120).optional().nullable(),
    serial_number: z.string().trim().min(1).max(120).optional().nullable(),
    commissioned_year: optionalYearSchema,
    hourly_rate: z.coerce.number().min(0).optional(),
    currency: currencyPatchSchema,
    status: machineStatusSchema.optional(),
    is_available: z.boolean().optional(),
    dashboard_color: z.string().trim().min(1).max(40).optional().nullable(),
    model_3d_path: optionalPathSchema,
    documentation_url: optionalUrlSchema,
    documentation_source: z.string().trim().min(1).max(120).optional().nullable(),
    scheduling_enabled: z.boolean().optional(),
    outillage_enabled: z.boolean().optional(),
    location: z.string().trim().min(1).max(200).optional().nullable(),
    workshop_zone: z.string().trim().min(1).max(200).optional().nullable(),
    notes: z.string().trim().min(1).optional().nullable(),
  }),
});

export type UpdateMachineBodyDTO = z.infer<typeof updateMachineSchema>["body"];

export const posteIdParamSchema = z.object({
  params: z.object({ id: uuid }),
});

export const listPostesQuerySchema = z.object({
  q: z.string().optional(),
  machine_id: uuid.optional(),
  is_active: z.preprocess(parseBoolean, z.boolean().optional()),
  include_archived: z.preprocess(parseBoolean, z.boolean().optional()).default(false),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z.enum(["updated_at", "created_at", "code", "label"]).optional().default("updated_at"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type ListPostesQueryDTO = z.infer<typeof listPostesQuerySchema>;

export const createPosteSchema = z.object({
  body: z.object({
    code: z.string().trim().min(1).max(50),
    label: z.string().trim().min(1).max(200),
    machine_id: uuid.optional().nullable(),
    hourly_rate_override: z.coerce.number().min(0).optional().nullable(),
    currency: currencySchema,
    is_active: z.boolean().optional().default(true),
    notes: z.string().trim().min(1).optional().nullable(),
  }),
});

export type CreatePosteBodyDTO = z.infer<typeof createPosteSchema>["body"];

export const updatePosteSchema = z.object({
  body: z.object({
    code: z.string().trim().min(1).max(50).optional(),
    label: z.string().trim().min(1).max(200).optional(),
    machine_id: uuid.optional().nullable(),
    hourly_rate_override: z.coerce.number().min(0).optional().nullable(),
    currency: currencyPatchSchema,
    is_active: z.boolean().optional(),
    notes: z.string().trim().min(1).optional().nullable(),
  }),
});

export type UpdatePosteBodyDTO = z.infer<typeof updatePosteSchema>["body"];

// -------------------------
// Ordres de fabrication (OF)
// -------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date (expected YYYY-MM-DD)");

export const ofStatusSchema = z.enum(["BROUILLON", "PLANIFIE", "EN_COURS", "EN_PAUSE", "TERMINE", "CLOTURE", "ANNULE"]);
export type OfStatusDTO = z.infer<typeof ofStatusSchema>;

export const ofPrioritySchema = z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]);
export type OfPriorityDTO = z.infer<typeof ofPrioritySchema>;

export const ofOperationStatusSchema = z.enum(["TODO", "READY", "RUNNING", "DONE", "BLOCKED"]);
export type OfOperationStatusDTO = z.infer<typeof ofOperationStatusSchema>;

export const ofTimeLogTypeSchema = z.enum(["SETUP", "PRODUCTION", "PROGRAMMING", "CONTROL", "MAINTENANCE"]);
export type OfTimeLogTypeDTO = z.infer<typeof ofTimeLogTypeSchema>;

export const ofIdParamSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

export const ofOperationIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
    opId: uuid,
  }),
});

// -------------------------
// Phase 5 - OF -> Entree en stock
// -------------------------

export const ofReceiptBodySchema = z
  .object({
    article_id: uuid.optional(),
    qty_ok: z.coerce.number().positive(),
    unite: z.string().trim().min(1).max(30).optional().nullable(),
    location_id: uuid,
    lot_mode: z.enum(["NEW", "EXISTING"]),
    lot_id: uuid.optional().nullable(),
    lot_number: z.string().trim().min(1).max(80).optional().nullable(),
    commentaire: z.string().trim().min(1).max(2000).optional().nullable(),
  })
  .strict();

export const createOfReceiptSchema = z.object({
  body: ofReceiptBodySchema,
});

export type OfReceiptBodyDTO = z.infer<typeof ofReceiptBodySchema>;

export const listOfQuerySchema = z.object({
  q: z.string().optional(),
  client_id: z.string().trim().min(1).max(3).optional(),
  affaire_id: z.coerce.number().int().positive().optional(),
  commande_id: z.coerce.number().int().positive().optional(),
  piece_technique_id: uuid.optional(),
  statut: ofStatusSchema.optional(),
  priority: ofPrioritySchema.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
  sortBy: z
    .enum(["updated_at", "created_at", "numero", "date_lancement_prevue", "date_fin_prevue", "statut", "priority"])
    .optional()
    .default("updated_at"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type ListOfQueryDTO = z.infer<typeof listOfQuerySchema>;

export const createOfSchema = z.object({
  body: z.object({
    numero: z.string().trim().min(1).max(30).optional(),
    affaire_id: z.coerce.number().int().positive().optional().nullable(),
    commande_id: z.coerce.number().int().positive().optional().nullable(),
    client_id: z.string().trim().min(1).max(3).optional().nullable(),
    piece_technique_id: uuid,
    quantite_lancee: z.coerce.number().positive().optional().default(1),
    priority: ofPrioritySchema.optional().default("NORMAL"),
    statut: ofStatusSchema.optional().default("BROUILLON"),
    date_lancement_prevue: isoDate.optional().nullable(),
    date_fin_prevue: isoDate.optional().nullable(),
    notes: z.string().trim().min(1).optional().nullable(),
  }),
});

export type CreateOfBodyDTO = z.infer<typeof createOfSchema>["body"];

export const updateOfSchema = z.object({
  body: z.object({
    affaire_id: z.coerce.number().int().positive().optional().nullable(),
    commande_id: z.coerce.number().int().positive().optional().nullable(),
    client_id: z.string().trim().min(1).max(3).optional().nullable(),
    quantite_lancee: z.coerce.number().positive().optional(),
    quantite_bonne: z.coerce.number().min(0).optional(),
    quantite_rebut: z.coerce.number().min(0).optional(),
    statut: ofStatusSchema.optional(),
    priority: ofPrioritySchema.optional(),
    date_lancement_prevue: isoDate.optional().nullable(),
    date_fin_prevue: isoDate.optional().nullable(),
    date_lancement_reelle: isoDate.optional().nullable(),
    date_fin_reelle: isoDate.optional().nullable(),
    notes: z.string().trim().min(1).optional().nullable(),
  }),
});

export type UpdateOfBodyDTO = z.infer<typeof updateOfSchema>["body"];

export const updateOfOperationSchema = z.object({
  body: z.object({
    poste_id: uuid.optional().nullable(),
    machine_id: uuid.optional().nullable(),
    status: ofOperationStatusSchema.optional(),
    notes: z.string().trim().min(1).optional().nullable(),
  }),
});

export type UpdateOfOperationBodyDTO = z.infer<typeof updateOfOperationSchema>["body"];

export const startOfTimeLogSchema = z.object({
  body: z.object({
    type: ofTimeLogTypeSchema.optional().default("PRODUCTION"),
    machine_id: uuid.optional().nullable(),
    comment: z.string().trim().min(1).optional().nullable(),
  }),
});

export type StartOfTimeLogBodyDTO = z.infer<typeof startOfTimeLogSchema>["body"];

export const stopOfTimeLogSchema = z.object({
  body: z.object({
    comment: z.string().trim().min(1).optional().nullable(),
  }),
});

export type StopOfTimeLogBodyDTO = z.infer<typeof stopOfTimeLogSchema>["body"];

export function validate(schema: z.ZodTypeAny) {
  return (req: unknown, res: unknown, next: unknown) => {
    const r = req as { body?: unknown; params?: unknown; query?: unknown };
    const parsed = schema.safeParse({ body: r.body, params: r.params, query: r.query });
    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request";
      (res as { status: (n: number) => { json: (v: unknown) => unknown } }).status(400).json({ error: msg });
      return;
    }
    (next as () => void)();
  };
}
