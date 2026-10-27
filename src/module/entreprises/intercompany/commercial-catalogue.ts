import { z } from "zod";

const uuid = z.string().guid().transform((value) => value.toLowerCase());
const money = z.number().finite().min(0).max(99_999_999);
const rate = z.number().finite().min(0).max(100);

export const intercompanySupplierRelationSchema = z.object({
  buyer_company_id: uuid, supplier_company_id: uuid, environment: z.enum(["cerp_prod", "cerp_test"]), local_supplier_id: uuid,
  local_customer_id: z.string().trim().min(1).max(120), approval_profile_ids: z.array(uuid).min(1).max(100), currency: z.string().trim().length(3).transform(value => value.toUpperCase()),
}).strict();
export type IntercompanySupplierRelationInput = z.infer<typeof intercompanySupplierRelationSchema>;

export const commercialCatalogueCreateSchema = z.object({
  relation_id: uuid,
  local_article_id: uuid.optional(),
  local_article: z.object({
    designation: z.string().trim().min(1).max(400),
    family_code: z.string().trim().min(1).max(40),
    unit: z.string().trim().min(1).max(30),
  }).strict().optional(),
  supplier_catalogue_id: uuid,
  supplier_catalogue_mapping_id: uuid,
  supplier_mapping_version: z.number().int().positive(),
  supplier_article_id: uuid,
  supplier_piece_technique_id: uuid.nullish(),
  supplier_piece_technique_version_id: uuid.nullish(),
  supplier_reference: z.string().trim().min(1).max(120).nullish(),
  designation: z.string().trim().min(1).max(400),
  unit: z.string().trim().min(1).max(30),
  buyer_sale_unit_price: money,
  buyer_sale_vat_rate: rate.default(20),
  purchase_unit_price: money,
  purchase_vat_rate: rate.default(20),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default("EUR"),
}).strict().superRefine((value, ctx) => {
  if ((value.local_article_id ? 1 : 0) + (value.local_article ? 1 : 0) !== 1) {
    ctx.addIssue({ code: "custom", path: ["local_article_id"], message: "Provide exactly one local_article_id or local_article." });
  }
  if (value.supplier_piece_technique_version_id && !value.supplier_piece_technique_id) {
    ctx.addIssue({ code: "custom", path: ["supplier_piece_technique_id"], message: "A supplier technical version requires its piece." });
  }
});
export type CommercialCatalogueCreate = z.infer<typeof commercialCatalogueCreateSchema>;

export const commercialCataloguePatchSchema = commercialCatalogueCreateSchema
  .omit({ relation_id: true, local_article_id: true, local_article: true, supplier_catalogue_id: true, supplier_mapping_version: true })
  .partial()
  .extend({ expected_version: z.number().int().positive(), active: z.boolean().optional() })
  .strict();
export type CommercialCataloguePatch = z.infer<typeof commercialCataloguePatchSchema>;

export type CommercialCatalogueItem = {
  id: string; relation_id: string; local_article_id: string; supplier_catalogue_id: string; supplier_catalogue_mapping_id: string;
  supplier_mapping_version?: number;
  supplier_article_id: string; supplier_piece_technique_id: string | null; supplier_piece_technique_version_id: string | null;
  supplier_reference: string | null; designation: string; unit: string;
  buyer_sale_unit_price: number; buyer_sale_vat_rate: number; purchase_unit_price: number; purchase_vat_rate: number;
  currency: string; version: number; active: boolean;
  supplier_sale_unit_price?: number | null; variant_code?: string; options_snapshot?: Record<string, unknown>;
};

export const supplierDropshipModeSchema = z.literal("SUPPLIER_DROPSHIP");
