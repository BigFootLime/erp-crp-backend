import { z } from "zod";

const uuid = z.string().guid().transform((value) => value.toLowerCase());
const money = z.number().finite().min(0).max(99_999_999);
const rate = z.number().finite().min(0).max(100);

export const intercompanySupplierRelationSchema = z.object({
  buyer_company_id: uuid, supplier_company_id: uuid, environment: z.enum(["cerp_prod", "cerp_test"]), local_supplier_id: uuid,
  local_customer_id: z.string().trim().min(1).max(120), approval_profile_ids: z.array(uuid).min(1).max(100), currency: z.string().trim().length(3).transform(value => value.toUpperCase()),
}).strict();
export type IntercompanySupplierRelationInput = z.infer<typeof intercompanySupplierRelationSchema>;

const commercialCatalogueObjectSchema = z.object({
  relation_id: uuid,
  local_article_id: uuid.optional(),
  local_article: z.object({
    designation: z.string().trim().min(1).max(400),
    family_code: z.string().trim().min(1).max(40),
    unit: z.string().trim().min(1).max(30),
  }).strict().optional(),
  // EC can start from a published CRP offer with no local article nor supplier
  // catalogue reference. The repository creates the local purchase reference
  // transactionally when this is omitted.
  supplier_catalogue_id: uuid.optional(),
  supplier_catalogue_mapping_id: uuid,
  supplier_mapping_version: z.number().int().positive(),
  supplier_article_id: uuid,
  supplier_piece_technique_id: uuid.nullish(),
  supplier_piece_technique_version_id: uuid.nullish(),
  supplier_reference: z.string().trim().min(1).max(120).nullish(),
  designation: z.string().trim().min(1).max(400),
  unit: z.string().trim().min(1).max(30),
  variant_code: z.string().trim().min(1).max(100),
  options_snapshot: z.record(z.string().max(80), z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()])),
  buyer_sale_unit_price: money,
  buyer_sale_vat_rate: rate.default(20),
  purchase_unit_price: money,
  purchase_vat_rate: rate.default(20),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default("EUR"),
}).strict();
export const commercialCatalogueCreateSchema = commercialCatalogueObjectSchema.superRefine((value, ctx) => {
  if ((value.local_article_id ? 1 : 0) + (value.local_article ? 1 : 0) !== 1) {
    ctx.addIssue({ code: "custom", path: ["local_article_id"], message: "Provide exactly one local_article_id or local_article." });
  }
  if (value.supplier_piece_technique_version_id && !value.supplier_piece_technique_id) {
    ctx.addIssue({ code: "custom", path: ["supplier_piece_technique_id"], message: "A supplier technical version requires its piece." });
  }
});
export type CommercialCatalogueCreate = z.infer<typeof commercialCatalogueCreateSchema>;

export const commercialCataloguePatchSchema = commercialCatalogueObjectSchema
  .omit({ relation_id: true, local_article_id: true, local_article: true, supplier_catalogue_id: true, supplier_mapping_version: true })
  .partial()
  .extend({ expected_version: z.number().int().positive(), active: z.boolean().optional() })
  .strict();
export type CommercialCataloguePatch = z.infer<typeof commercialCataloguePatchSchema>;
export const supplierCommercialOfferSchema=z.object({relation_id:uuid,local_article_id:uuid,supplier_piece_technique_id:uuid.nullish(),supplier_piece_technique_version_id:uuid.nullish(),supplier_reference:z.string().trim().min(1).max(160).nullish(),designation:z.string().trim().min(1).max(400),unit:z.string().trim().min(1).max(30),variant_code:z.string().trim().min(1).max(100),options_snapshot:z.record(z.string().max(80),z.union([z.string().max(500),z.number().finite(),z.boolean(),z.null()])).default({}),supplier_sale_unit_price:money,purchase_vat_rate:rate.default(20),currency:z.string().regex(/^[A-Z]{3}$/).default("EUR")}).strict().superRefine((v,c)=>{if(v.supplier_piece_technique_version_id&&!v.supplier_piece_technique_id)c.addIssue({code:"custom",path:["supplier_piece_technique_id"],message:"A technical version requires its piece."})});
export type SupplierCommercialOffer=z.infer<typeof supplierCommercialOfferSchema>;
export const supplierCommercialOfferPatchSchema=z.object({supplier_reference:z.string().trim().min(1).max(160).nullish(),designation:z.string().trim().min(1).max(400).optional(),unit:z.string().trim().min(1).max(30).optional(),variant_code:z.string().trim().min(1).max(100).optional(),options_snapshot:z.record(z.string().max(80),z.union([z.string().max(500),z.number().finite(),z.boolean(),z.null()])).optional(),supplier_sale_unit_price:money.optional(),purchase_vat_rate:rate.optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),active:z.boolean().optional(),expected_version:z.number().int().positive()}).strict();
export type SupplierCommercialOfferPatch=z.infer<typeof supplierCommercialOfferPatchSchema>;

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
