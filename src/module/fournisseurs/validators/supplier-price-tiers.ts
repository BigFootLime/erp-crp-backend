import { z } from "zod";

/** Purchase quantities: lower bound inclusive, upper bound exclusive. */
export const supplierPriceTiersSchema = z.array(z.object({
  qty_min: z.number().finite().min(0),
  qty_max: z.number().finite().positive().nullable(),
  unit_price: z.number().finite().min(0),
}).strict()).max(50).superRefine((tiers, ctx) => {
  const sorted = tiers.map((tier, index) => ({ ...tier, index })).sort((a, b) => a.qty_min - b.qty_min);
  sorted.forEach((tier, index) => {
    if (tier.qty_max !== null && tier.qty_max <= tier.qty_min)
      ctx.addIssue({ code: "custom", path: [tier.index, "qty_max"], message: "La borne haute doit dépasser la borne basse." });
    const previous = sorted[index - 1];
    if (previous && (previous.qty_max === null || previous.qty_max > tier.qty_min))
      ctx.addIssue({ code: "custom", path: [tier.index, "qty_min"], message: "Les paliers ne doivent pas se chevaucher." });
  });
});
export type SupplierPriceTier = z.infer<typeof supplierPriceTiersSchema>[number];
