import { z } from "zod";

import { codeFormatExample, isValidCode } from "../../../shared/codes/code-validator";

export const qualityLevels = z.enum(["Certificat MP", "Certificat TR", "Relevé de valeurs"]);
export const QUALITY_LEVELS = ["Certificat MP", "Certificat TR", "Relevé de valeurs"] as const;

const siretRegex = /^\d{14}$/;
const nafRegex = /^\d{4}[A-Z]$/;
const frVatRegex = /^FR[0-9A-Z]{2}\s?\d{9}$/i;
const ibanRegex = /^[A-Z]{2}[0-9A-Z]{13,32}$/i;
const bicRegex = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/i;
const CIVILITY_OPTIONS = ["Madame", "Monsieur"] as const;
const clientCodeFormatMessage = `Le code client doit être au format ${codeFormatExample("client")}.`;

function emptyStringToUndefined(value: unknown) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDefined<T>(value: T | undefined): value is T {
  return typeof value !== "undefined";
}

function requiredText(message: string) {
  return z.string({ required_error: message, invalid_type_error: message }).trim().min(1, message);
}

function optionalTrimmedText(value: unknown): string | undefined | null {
  if (typeof value !== "string") return value as undefined | null;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

type ContactInput = {
  contact_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone_direct?: string | null;
  phone_personal?: string | null;
  role?: string | null;
  civility?: string | null;
};

type NormalizedContact = {
  contact_id?: string | null;
  first_name: string;
  last_name: string;
  email: string;
  phone_direct?: string | null;
  phone_personal?: string | null;
  role?: string | null;
  civility?: string | null;
};

function isBlankContactInput(value: ContactInput | undefined | null) {
  if (!value) return true;

  return ![
    value.first_name,
    value.last_name,
    value.email,
    value.phone_direct,
    value.phone_personal,
    value.role,
    value.civility,
  ].some(hasText);
}

function normalizeContact(value: ContactInput): NormalizedContact | undefined {
  if (isBlankContactInput(value)) return undefined;

  return {
    ...(value.contact_id ? { contact_id: value.contact_id } : {}),
    first_name: value.first_name?.trim() ?? "",
    last_name: value.last_name?.trim() ?? "",
    email: value.email?.trim() ?? "",
    ...(optionalTrimmedText(value.phone_direct) ? { phone_direct: optionalTrimmedText(value.phone_direct) } : {}),
    ...(optionalTrimmedText(value.phone_personal) ? { phone_personal: optionalTrimmedText(value.phone_personal) } : {}),
    ...(optionalTrimmedText(value.role) ? { role: optionalTrimmedText(value.role) } : {}),
    ...(optionalTrimmedText(value.civility) ? { civility: optionalTrimmedText(value.civility) } : {}),
  };
}

export const addressSchema = z.object({
  name: requiredText("Nom de l'adresse requis"),
  street: requiredText("Rue requise"),
  house_number: z.preprocess(emptyStringToUndefined, z.string().trim().optional().nullable()),
  address_complement: z.preprocess(emptyStringToUndefined, z.string().trim().optional().nullable()),
  postal_code: requiredText("Code postal requis"),
  city: requiredText("Ville requise"),
  country: requiredText("Pays requis"),
});

const contactInputSchema = z
  .object({
    contact_id: z.preprocess(
      emptyStringToUndefined,
      z.string().uuid("Identifiant de contact invalide").optional().nullable()
    ),
    first_name: z.union([z.string(), z.literal(""), z.null()]).optional(),
    last_name: z.union([z.string(), z.literal(""), z.null()]).optional(),
    email: z.union([z.string(), z.literal(""), z.null()]).optional(),
    phone_direct: z.union([z.string(), z.literal(""), z.null()]).optional(),
    phone_personal: z.union([z.string(), z.literal(""), z.null()]).optional(),
    role: z.union([z.string(), z.literal(""), z.null()]).optional(),
    civility: z.union([z.string(), z.literal(""), z.null()]).optional(),
  })
  .superRefine((value, ctx) => {
    if (isBlankContactInput(value)) return;

    if (!hasText(value.first_name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["first_name"], message: "Prénom requis" });
    }

    if (!hasText(value.last_name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["last_name"], message: "Nom requis" });
    }

    if (!hasText(value.email)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["email"], message: "Email requis" });
      return;
    }

    if (!z.string().email("Email invalide").safeParse(value.email.trim()).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["email"], message: "Email invalide" });
    }

    const civility = typeof value.civility === "string" ? value.civility.trim() : "";
    if (civility && !CIVILITY_OPTIONS.includes(civility as (typeof CIVILITY_OPTIONS)[number])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["civility"],
        message: "Civilité invalide (Madame ou Monsieur)",
      });
    }
  });

const normalizedContactSchema = contactInputSchema.transform((value) => normalizeContact(value));

const bankInputSchema = z
  .object({
    bank_name: z.preprocess(emptyStringToUndefined, z.string().trim().optional()),
    iban: z.preprocess(emptyStringToUndefined, z.string().trim().optional()),
    bic: z.preprocess(emptyStringToUndefined, z.string().trim().optional()),
  })
  .superRefine((value, ctx) => {
    const bankName = typeof value.bank_name === "string" ? value.bank_name.trim() : "";
    const ibanRaw = typeof value.iban === "string" ? value.iban.trim() : "";
    const bicRaw = typeof value.bic === "string" ? value.bic.trim() : "";

    if (!bankName && !ibanRaw && !bicRaw) return;

    if (!ibanRaw) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["iban"],
        message: "IBAN requis pour enregistrer des coordonnées bancaires",
      });
      return;
    }

    const iban = ibanRaw.replace(/\s+/g, "").toUpperCase();
    if (!ibanRegex.test(iban)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["iban"], message: "IBAN invalide" });
    }

    if (bicRaw) {
      const bic = bicRaw.replace(/\s+/g, "").toUpperCase();
      if (!bicRegex.test(bic)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bic"], message: "BIC invalide" });
      }
    }
  });

export const bankSchema = bankInputSchema.transform((value) => {
  const bankName = typeof value.bank_name === "string" ? value.bank_name.trim() : "";
  const ibanRaw = typeof value.iban === "string" ? value.iban.trim() : "";
  const bicRaw = typeof value.bic === "string" ? value.bic.trim() : "";

  if (!bankName && !ibanRaw && !bicRaw) return undefined;

  const iban = ibanRaw ? ibanRaw.replace(/\s+/g, "").toUpperCase() : undefined;
  const bic = bicRaw ? bicRaw.replace(/\s+/g, "").toUpperCase() : undefined;

  return {
    ...(bankName ? { bank_name: bankName } : {}),
    ...(iban ? { iban } : {}),
    ...(bic ? { bic } : {}),
  };
});

export const createClientSchema = z.object({
  client_code: z.preprocess(
    emptyStringToUndefined,
    z
      .string()
      .trim()
      .max(30, "Code client trop long")
      .refine((value) => isValidCode("client", value), clientCodeFormatMessage)
      .optional()
  ),
  company_name: requiredText("Raison sociale requise"),
  email: z.preprocess(emptyStringToUndefined, z.string().trim().email("Email invalide").optional()),
  phone: z.preprocess(emptyStringToUndefined, z.string().trim().optional()),
  website_url: z.preprocess(emptyStringToUndefined, z.string().trim().url("URL invalide").optional()),
  siret: z.preprocess(emptyStringToUndefined, z.string().trim().regex(siretRegex, "SIRET invalide").optional()),
  vat_number: z.preprocess(emptyStringToUndefined, z.string().trim().regex(frVatRegex, "TVA invalide").optional()),
  naf_code: z.preprocess(emptyStringToUndefined, z.string().trim().regex(nafRegex, "Code NAF invalide").optional()),
  status: z.enum(["prospect", "client", "inactif"]),
  blocked: z.boolean(),
  reason: z.preprocess(emptyStringToUndefined, z.string().trim().optional()),
  creation_date: requiredText("Date de création requise"),
  biller_id: z.preprocess(
    emptyStringToUndefined,
    z.string().uuid("L'entité de facturation est invalide").optional()
  ),
  payment_mode_ids: z.array(z.string().uuid("Le mode de règlement est invalide")).default([]),
  bank: bankSchema.optional().transform((value) => value ?? undefined),
  observations: z.preprocess(emptyStringToUndefined, z.string().trim().optional()),
  provided_documents_id: z.preprocess(
    emptyStringToUndefined,
    z.string().uuid("Le document fourni est invalide").optional()
  ),
  bill_address: addressSchema,
  delivery_address: addressSchema,
  primary_contact: normalizedContactSchema.optional().transform((value) => value ?? undefined),
  quality_level: z.preprocess(emptyStringToUndefined, qualityLevels.optional()),
  quality_levels: z.array(z.enum(QUALITY_LEVELS)).default([]),
  contacts: z
    .array(normalizedContactSchema)
    .optional()
    .default([])
    .transform((contacts) => contacts.filter(isDefined)),
});

export type CreateClientDTO = z.infer<typeof createClientSchema>;
