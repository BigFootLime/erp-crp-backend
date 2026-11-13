import db from "../../../config/database";
import {
  classifySupplierPromiseExceptions,
  type SupplierPromiseInput,
} from "../domain/supplier-promise-exceptions";

type Row = SupplierPromiseInput & {
  promisedLine: string | null;
  promisedOrder: string | null;
  estimatedReturnDate: string | null;
};

export async function readSupplierPromiseExceptions(today: string) {
  const rows = (
    await db.query<Row>(
      `SELECT l.id::text AS id,c.code AS "orderCode",COALESCE(f.nom,f.raison_sociale,c.fournisseur_id::text) AS "supplierName",
       c.statut::text AS status,l.date_promesse::text AS "promisedLine",c.date_promesse::text AS "promisedOrder",
       estimate.estimated_return_date::text AS "estimatedReturnDate",
       COALESCE(l.date_besoin,c.date_besoin)::text AS "needDate",l.quantite::float8 AS ordered,
       COALESCE((SELECT sum(rl.qty_received*COALESCE(rl.stock_conversion_coef,l.coef_conversion,1))
         FROM public.reception_fournisseur_lignes rl JOIN public.receptions_fournisseurs receipt ON receipt.id=rl.reception_id
         WHERE rl.commande_fournisseur_ligne_id=l.id AND receipt.status<>'CANCELLED'),0)::float8 AS received,
       (l.type='SOUS_TRAITANCE' OR l.operation_libelle IS NOT NULL)::boolean AS "isSubcontract",
       l.of_id::int AS "ofId",l.commande_client_id::int AS "customerOrderId"
     FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id
     LEFT JOIN public.fournisseurs f ON f.id=c.fournisseur_id
     LEFT JOIN public.supplier_internal_treatment_estimates estimate ON estimate.line_id=l.id AND estimate.status='ESTIMATED'
     WHERE l.statut_ligne='ACTIVE' AND c.statut IN('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE')
     ORDER BY COALESCE(l.date_promesse,c.date_promesse) NULLS FIRST,c.created_at,l.position,l.id LIMIT 2001`,
    )
  ).rows;
  const normalized = rows.map(
    ({ promisedLine, promisedOrder, estimatedReturnDate, ...row }) => ({
      ...row,
      promisedDate: promisedLine ?? promisedOrder,
      estimatedReturnDate,
      promiseEvidence:
        (promisedLine ?? promisedOrder)
          ? "CONFIRMED"
          : estimatedReturnDate
            ? "ESTIMATED_NOT_CONFIRMED"
            : "MISSING",
    }),
  );
  return classifySupplierPromiseExceptions(normalized, today);
}
