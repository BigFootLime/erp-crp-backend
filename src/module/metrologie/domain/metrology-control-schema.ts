import { z } from "zod";

const valueKind = z.enum(["text", "number", "date", "boolean"]);
const fieldShape = {
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/),
  label: z.string().trim().min(1).max(500),
  value_kind: valueKind,
  unit: z.string().trim().min(1).max(32).nullable().optional(),
};

/** These fields preserve the source form's context. Only versioned plan
 * measurements participate in the metrology verdict. */
export const metrologyControlSchema = z.object({
  version: z.literal(1),
  fields: z.array(z.object({
    ...fieldShape,
    required: z.boolean().optional().default(false),
  }).strict()).max(100),
}).strict().superRefine((schema, context) => {
  const seen = new Set<string>();
  schema.fields.forEach((field, index) => {
    if (seen.has(field.key)) context.addIssue({
      code: "custom", path: ["fields", index, "key"], message: "Identifiant de champ répété.",
    });
    seen.add(field.key);
  });
});

export const metrologyAdditionalFieldsSchema = z.array(z.object({
  ...fieldShape,
  value: z.union([z.string().max(32767), z.number().finite(), z.boolean(), z.null()]),
}).strict().superRefine((field, context) => {
  if (field.value === null) return;
  const expected = ["date", "text"].includes(field.value_kind) ? "string" : field.value_kind;
  if (typeof field.value !== expected) {
    context.addIssue({ code: "custom", path: ["value"], message: "Le type de la valeur ne correspond pas au champ." });
    return;
  }
  if (field.value_kind === "date") {
    const parsed = z.iso.date().safeParse(field.value);
    if (!parsed.success) context.addIssue({
      code: "custom", path: ["value"], message: "Date valide attendue au format AAAA-MM-JJ.",
    });
  }
})).max(100).superRefine((fields, context) => {
  const seen = new Set<string>();
  fields.forEach((field, index) => {
    if (seen.has(field.key)) context.addIssue({
      code: "custom", path: [index, "key"], message: "Identifiant de champ répété.",
    });
    seen.add(field.key);
  });
});

export type MetrologyControlSchema = z.infer<typeof metrologyControlSchema>;
export type MetrologyAdditionalFields = z.infer<typeof metrologyAdditionalFieldsSchema>;
