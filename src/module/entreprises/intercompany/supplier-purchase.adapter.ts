import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type { CreateCommandeInput } from "../../commande-client/types/commande-client.types";
import { purchaseSubmittedPayloadSchema, type PurchaseSubmittedPayload } from "./intercompany-purchase.contract";
export { purchaseSubmittedPayloadSchema } from "./intercompany-purchase.contract";

export type SupplierPurchasePayload = PurchaseSubmittedPayload;

/** Resolves only declared seller bindings; missing, stale or price-fallback data fail closed. */
export async function resolveSupplierPurchaseTx(tx: Pick<PoolClient, "query">, payloadInput: unknown, scope: { source_company_id: string; destination_company_id: string; environment: "cerp_prod" | "cerp_test" }): Promise<CreateCommandeInput> {
  const payload = purchaseSubmittedPayloadSchema.parse(payloadInput);
  const outputLines: CreateCommandeInput["lignes"] = [];
  let customerId: string | null = null;
  for (const [index, line] of payload.lines.entries()) {
    const found = await tx.query<{ local_customer_id: string; active: boolean; version: number; supplier_article_id: string; supplier_piece_technique_id: string | null; supplier_piece_technique_version_id: string | null; unit: string; supplier_sale_unit_price: number; purchase_vat_rate: number; currency: string; designation: string }>(
      `SELECT r.local_customer_id,c.active,c.version,c.supplier_article_id::text,c.supplier_piece_technique_id::text,c.supplier_piece_technique_version_id::text,c.unit,c.supplier_sale_unit_price::float8,c.purchase_vat_rate::float8,c.currency,c.designation
         FROM public.intercompany_commercial_catalogue c JOIN public.intercompany_supplier_relations r ON r.id=c.relation_id
        WHERE c.id=$1::uuid AND c.relation_id=$2::uuid AND r.local_role='SUPPLIER' AND c.local_role='SUPPLIER'
          AND r.buyer_company_id=$3::uuid AND r.supplier_company_id=$4::uuid AND r.environment=$5 AND r.status='ACTIVE' FOR SHARE OF c,r`, [line.supplier_catalogue_mapping_id, payload.relation_id, scope.source_company_id, scope.destination_company_id, scope.environment]);
    const row = found.rows[0];
    if (!row || !row.active || row.version !== line.supplier_mapping_version || row.supplier_article_id !== line.supplier_article_id || row.supplier_piece_technique_id !== (line.supplier_piece_technique_id ?? null) || row.supplier_piece_technique_version_id !== (line.supplier_piece_technique_version_id ?? null) || row.unit !== line.unit || row.currency !== line.currency || row.supplier_sale_unit_price !== line.purchase_unit_price || row.purchase_vat_rate !== line.purchase_vat_rate) {
      throw new HttpError(409, "INTERCOMPANY_PURCHASE_BINDING_STALE", `La ligne fournisseur ${index + 1} ne correspond plus au catalogue publié.`);
    }
    if (customerId && customerId !== row.local_customer_id) throw new HttpError(409, "INTERCOMPANY_RELATION_CUSTOMER_CONFLICT", "La relation ne désigne pas un client vendeur unique.");
    customerId = row.local_customer_id;
    outputLines.push({ article_id: row.supplier_article_id, piece_technique_id: row.supplier_piece_technique_id, piece_technique_version_id: row.supplier_piece_technique_version_id, designation: row.designation, code_piece: line.supplier_reference ?? null, quantite: line.quantity, unite: line.unit, prix_unitaire_ht: row.supplier_sale_unit_price, taux_tva: row.purchase_vat_rate, delai_client: "Intercompany", reference_price_decision: "KEEP" });
  }
  if (!customerId) throw new HttpError(409, "INTERCOMPANY_RELATION_CUSTOMER_REQUIRED", "La relation vendeur ne désigne aucun client local.");
  const totalHt = outputLines.reduce((sum, line) => sum + line.quantite * line.prix_unitaire_ht, 0);
  const totalTtc = outputLines.reduce((sum, line) => sum + line.quantite * line.prix_unitaire_ht * (1 + (line.taux_tva ?? 0) / 100), 0);
  const delivery=payload.final_delivery_address_snapshot;
  return { client_id: customerId, code_client: `IC-${payload.buyer_sales_order_id}`, date_commande: new Date().toISOString().slice(0, 10), order_type: "FERME", commentaire: `Commande interentreprises ${payload.buyer_purchase_order_id}`, fulfilment_mode: "STANDARD", intercompany_delivery_address: {recipient_name:delivery.recipient_name,address_lines:delivery.address_lines,country_code:delivery.country_code??null,contact_name:delivery.contact_name??null,contact_phone:delivery.contact_phone??null} as unknown as Record<string,string|null>, lignes: outputLines, total_ht: totalHt, total_ttc: totalTtc };
}
