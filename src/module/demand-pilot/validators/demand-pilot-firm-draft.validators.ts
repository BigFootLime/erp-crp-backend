import { z } from "zod";
const money = z.coerce.number().finite().min(0).max(1_000_000_000);
const tax = z.coerce.number().finite().min(0).max(100);
export const firmDraftSchema = z
  .object({
    client_id: z.string().trim().min(1).max(80),
    revision_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(200)
      .transform((v) => [...new Set(v)]),
    // Every non-derived commercial value is explicit. ADV may safely use a
    // verified quote line; otherwise this is the controlled manual fallback.
    lines: z
      .array(
        z
          .object({
            revision_id: z.string().uuid(),
            designation: z.string().trim().min(1).max(500),
            prix_unitaire_ht: money,
            taux_tva: tax,
            remise_ligne: z.coerce.number().finite().min(0).max(100).default(0),
            reference_price_quote_line_id: z.coerce
              .number()
              .int()
              .positive()
              .nullable()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    commentaire: z.string().trim().max(2000).nullable().optional(),
    mode_reglement_id: z.string().uuid().nullable().optional(),
    conditions_paiement_id: z.coerce
      .number()
      .int()
      .positive()
      .nullable()
      .optional(),
    biller_id: z.string().uuid().nullable().optional(),
    compte_vente_id: z.string().uuid().nullable().optional(),
    client_contract_call: z
      .object({
        contract_id: z.string().uuid(),
        expected_version: z.coerce.number().int().positive(),
        idempotency_key: z.string().uuid(),
      })
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = new Set(v.revision_ids);
    const lines = new Set(v.lines.map((x) => x.revision_id));
    if (ids.size !== lines.size || [...ids].some((id) => !lines.has(id)))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lines"],
        message:
          "Chaque révision sélectionnée doit avoir exactement une ligne commerciale.",
      });
  });
export type FirmDraftInput = z.infer<typeof firmDraftSchema>;
