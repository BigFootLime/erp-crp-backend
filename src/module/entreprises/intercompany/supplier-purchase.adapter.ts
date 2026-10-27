import type { PoolClient } from "pg";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import type { CreateCommandeInput } from "../../commande-client/types/commande-client.types";

const uuid = z.string().guid().transform(value => value.toLowerCase());
const lineSchema = z.object({
  buyer_sales_order_line_id: z.string().regex(/^\d+$/), buyer_purchase_order_line_id: uuid,
  catalogue_mapping_id: uuid, supplier_catalogue_mapping_id: uuid, mapping_version: z.number().int().positive(), supplier_article_id: uuid,
  supplier_piece_technique_id: uuid.nullish(), supplier_piece_technique_version_id: uuid.nullish(), supplier_reference: z.string().nullish(),
  quantity: z.number().finite().positive(), unit: z.string().trim().min(1).max(30), purchase_unit_price: z.number().finite().min(0), purchase_vat_rate: z.number().finite().min(0).max(100), currency: z.string().length(3),
}).strict();
const payloadSchema = z.object({
  schema_version: z.literal(1), buyer_sales_order_id: z.string().regex(/^\d+$/), buyer_purchase_order_id: uuid, relation_id: uuid,
  delivery_address: z.object({ name: z.string().nullish(), house_number: z.string().nullish(), street: z.string().nullish(), address_complement: z.string().nullish(), postal_code: z.string().nullish(), city: z.string().nullish(), country: z.string().nullish() }).strict(),
  lines: z.array(lineSchema).min(1).max(200),
}).strict();
export type SupplierPurchasePayload = z.infer<typeof payloadSchema>;

/** Resolves only declared seller bindings; missing, stale or price-fallback data fail closed. */
export async function resolveSupplierPurchaseTx(tx: Pick<PoolClient, "query">, payloadInput: unknown, scope: { source_company_id: string; destination_company_id: string; environment: "cerp_prod" | "cerp_test" }): Promise<CreateCommandeInput> {
  const payload = payloadSchema.parse(payloadInput);
  const outputLines: CreateCommandeInput["lignes"] = [];
  let customerId: string | null = null;
  for (const [index, line] of payload.lines.entries()) {
    const found = await tx.query<{ local_customer_id: string; active: boolean; version: number; supplier_article_id: string; supplier_piece_technique_id: string | null; supplier_piece_technique_version_id: string | null; unit: string; purchase_unit_price: number; purchase_vat_rate: number; currency: string; designation: string }>(
      `SELECT r.local_customer_id,c.active,c.version,c.supplier_article_id::text,c.supplier_piece_technique_id::text,c.supplier_piece_technique_version_id::text,c.unit,c.purchase_unit_price::float8,c.purchase_vat_rate::float8,c.currency,c.designation
         FROM public.intercompany_commercial_catalogue c JOIN public.intercompany_supplier_relations r ON r.id=c.relation_id
        WHERE c.id=$1::uuid AND c.relation_id=$2::uuid AND r.buyer_company_id=$3::uuid AND r.supplier_company_id=$4::uuid AND r.environment=$5 AND r.status='ACTIVE' FOR SHARE OF c,r`, [line.supplier_catalogue_mapping_id, payload.relation_id, scope.source_company_id, scope.destination_company_id, scope.environment]);
    const row = found.rows[0];
    if (!row || !row.active || row.version !== line.mapping_version || row.supplier_article_id !== line.supplier_article_id || row.supplier_piece_technique_id !== (line.supplier_piece_technique_id ?? null) || row.supplier_piece_technique_version_id !== (line.supplier_piece_technique_version_id ?? null) || row.unit !== line.unit || row.currency !== line.currency || row.purchase_unit_price !== line.purchase_unit_price || row.purchase_vat_rate !== line.purchase_vat_rate) {
      throw new HttpError(409, "INTERCOMPANY_PURCHASE_BINDING_STALE", `La ligne fournisseur ${index + 1} ne correspond plus au catalogue publié.`);
    }
    if (customerId && customerId !== row.local_customer_id) throw new HttpError(409, "INTERCOMPANY_RELATION_CUSTOMER_CONFLICT", "La relation ne désigne pas un client vendeur unique.");
    customerId = row.local_customer_id;
    outputLines.push({ article_id: row.supplier_article_id, piece_technique_id: row.supplier_piece_technique_id, piece_technique_version_id: row.supplier_piece_technique_version_id, designation: row.designation, code_piece: line.supplier_reference ?? null, quantite: line.quantity, unite: line.unit, prix_unitaire_ht: line.purchase_unit_price, taux_tva: line.purchase_vat_rate, delai_client: "Intercompany", reference_price_decision: "KEEP" });
  }
  const address = payload.delivery_address;
  const delivery = [address.name, address.house_number, address.street, address.address_complement, address.postal_code, address.city, address.country].filter(Boolean).join(", ");
  if (!delivery) throw new HttpError(400, "INTERCOMPANY_DELIVERY_ADDRESS_REQUIRED", "Une adresse de livraison directe est requise.");
  const totalHt = outputLines.reduce((sum, line) => sum + line.quantite * line.prix_unitaire_ht, 0);
  const totalTtc = outputLines.reduce((sum, line) => sum + line.quantite * line.prix_unitaire_ht * (1 + (line.taux_tva ?? 0) / 100), 0);
  return { client_id: customerId, code_client: `IC-${payload.buyer_sales_order_id}`, date_commande: new Date().toISOString().slice(0, 10), order_type: "FERME", commentaire: `Commande interentreprises ${payload.buyer_purchase_order_id}`, intercompany_delivery_address: Object.fromEntries(Object.entries(address).map(([key, value]) => [key, value ?? null])), lignes: outputLines, total_ht: totalHt, total_ttc: totalTtc };
}
