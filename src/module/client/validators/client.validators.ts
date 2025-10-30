// src/module/clients/validators/clients.validators.ts
import { z } from "zod";

export const qualityLevels = z.enum(["Certificat MP","Certificat TR","Relevé de valeurs"]);
export const QUALITY_LEVELS = ['Certificat MP', 'Certificat TR', 'Relevé de valeurs'] as const;

export const addressSchema = z.object({
  name: z.string().min(1),
  street: z.string().min(1),
  house_number: z.string().optional().nullable(),
  postal_code: z.string().min(1),
  city: z.string().min(1),
  country: z.string().min(1),
});
export const contactSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().email(),
  phone_personal: z.string().optional().nullable(),
  role: z.string().optional().nullable(),
  civility: z.string().optional().nullable(),
});
export const bankSchema = z.object({
  bank_name: z.string().min(1),
  iban: z.string().min(15),
  bic: z.string().min(8),
});
export const createClientSchema = z.object({
  company_name: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  website_url: z.string().url().optional().or(z.literal("")),
  siret: z.string().optional().or(z.literal("")),
  vat_number: z.string().optional().or(z.literal("")),
  naf_code: z.string().optional().or(z.literal("")),
  status: z.enum(["prospect","client","inactif"]),
  blocked: z.boolean(),
  reason: z.string().optional().or(z.literal("")),
  creation_date: z.string().min(1),

   payment_mode_ids: z.array(z.string().uuid("payment_mode must be a UUID")).default([]),
  bank: bankSchema,

  observations: z.string().optional().or(z.literal("")),
  provided_documents_id: z.string().uuid().optional().or(z.literal("")), // ✅ accepte ""
  bill_address: addressSchema,
  delivery_address: addressSchema,
  primary_contact: contactSchema.optional(),
  quality_level: qualityLevels.optional().or(z.literal("")).default(""),
  quality_levels: z
    .array(z.enum(QUALITY_LEVELS))
    .default([]),
  contacts: z.array(contactSchema).optional().default([]),


});
export type CreateClientDTO = z.infer<typeof createClientSchema>;

