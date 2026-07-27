import { z } from "zod";

import { IMPORT_ENTITY_TYPES, IMPORT_ROW_STATUSES } from "../types/import-assistant.types";

export const importEntityTypeSchema = z.enum(IMPORT_ENTITY_TYPES);

export const createImportBatchFieldsSchema = z.object({
  entity_type: importEntityTypeSchema,
  source_system: z.string().trim().min(1).max(40).optional().default("CLIPPER"),
  sheet_name: z.string().trim().min(1).max(200).optional(),
}).strict();

const mappingValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const previewImportBatchSchema = z.object({
  columns: z.record(z.string().trim().min(1).max(200)).default({}),
  constants: z.record(mappingValueSchema).default({}),
  legacy_key_column: z.string().trim().min(1).max(200),
  approved_decisions: z.array(z.string().trim().regex(/^DEC-\d{2}$/)).max(30).default([]),
  duplicate_strategy: z.enum(["REVIEW", "LINK_EXACT"]).default("REVIEW"),
}).strict();

export const importBatchIdSchema = z.object({
  id: z.string().uuid(),
});

export const listImportBatchesQuerySchema = z.object({
  entity_type: importEntityTypeSchema.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
}).strict();

export const listImportRowsQuerySchema = z.object({
  status: z.enum(IMPORT_ROW_STATUSES).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
}).strict();

export const confirmImportBatchSchema = z.object({
  expected_preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
