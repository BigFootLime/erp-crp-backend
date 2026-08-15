import { z } from "zod";
import {
  IDENTIFICATION_ENTITY_TYPES,
  IDENTIFICATION_FLOWS,
  IDENTIFICATION_LABEL_PROFILES,
  IDENTIFICATION_SYMBOLOGIES,
} from "./domain/identification";

export const identificationEntityTypeSchema = z.enum(IDENTIFICATION_ENTITY_TYPES);
export const identificationFlowSchema = z.enum(IDENTIFICATION_FLOWS);
export const identificationSymbologySchema = z.enum(IDENTIFICATION_SYMBOLOGIES);
export const identificationLabelProfileSchema = z.enum(IDENTIFICATION_LABEL_PROFILES);
export const identificationUuidSchema = z.string().uuid();

export const issueIdentificationLabelSchema = z.object({
  entity_type: identificationEntityTypeSchema,
  entity_id: z.string().trim().min(1).max(128),
}).strict();

export const printIdentificationLabelSchema = z.object({
  symbology: identificationSymbologySchema,
  label_profile: identificationLabelProfileSchema,
  reason: z.string().trim().min(3).max(500).optional(),
}).strict();

export const invalidateIdentificationLabelSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();

export const replaceIdentificationLabelSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();

export const resolveIdentificationSchema = z.object({
  event_id: identificationUuidSchema,
  code: z.string().trim().min(1).max(256),
  source: z.enum(["KEYBOARD", "CAMERA", "MANUAL", "OFFLINE"]),
  flow: identificationFlowSchema,
  expected_entity_types: z.array(identificationEntityTypeSchema).max(9).optional().default([]),
  client_scanned_at: z.string().datetime({ offset: true }),
  device_id: z.string().trim().min(1).max(120).optional(),
}).strict();

export const syncIdentificationOfflineSchema = z.object({
  events: z.array(resolveIdentificationSchema).min(1).max(50),
}).strict();

export const listIdentificationLabelsSchema = z.object({
  entity_type: identificationEntityTypeSchema.optional(),
  entity_id: z.string().trim().min(1).max(128).optional(),
  status: z.enum(["ACTIVE", "INVALIDATED", "REPLACED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export type IssueIdentificationLabelDTO = z.infer<typeof issueIdentificationLabelSchema>;
export type PrintIdentificationLabelDTO = z.infer<typeof printIdentificationLabelSchema>;
export type ResolveIdentificationDTO = z.infer<typeof resolveIdentificationSchema>;
