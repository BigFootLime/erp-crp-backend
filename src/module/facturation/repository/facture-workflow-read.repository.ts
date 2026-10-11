import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { DbQueryer } from "./workflow.repository.shared";

type SavedFactureWorkflow = {
  id: number;
  uuid: string;
  draft_reference: string;
  legal_number: string | null;
  status: string;
  row_version: number;
  preview_hash: string | null;
  client_name: string;
  currency: string;
  total_ex_tax: string;
  total_tax: string;
  total_incl_tax: string;
  lines: Array<{ id: string; designation: string; code_piece: string | null; quantity: string; unit: string | null; total_ex_tax: string }>;
  due_dates: Array<{ due_date: string; label: string; amount: string }>;
};

/** Read the saved document in one snapshot, without re-consuming its BL sources. */
export async function repoGetFactureWorkflow(factureId: number, queryer: DbQueryer = pool) {
  const result = await queryer.query<SavedFactureWorkflow>(`
    SELECT f.id, f.uuid::text, f.draft_reference, f.legal_number,
           f.statut AS status, f.row_version, f.preview_hash,
           COALESCE(f.client_snapshot->>'company_name', c.company_name, '') AS client_name,
           f.currency, f.total_ht::text AS total_ex_tax,
           f.total_tax::text, f.total_ttc::text AS total_incl_tax,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'id', l.id::text, 'designation', l.designation, 'code_piece', l.code_piece,
               'quantity', l.quantite::text, 'unit', l.unite, 'total_ex_tax', l.total_ht::text
             ) ORDER BY l.ordre, l.id)
             FROM public.facture_ligne l WHERE l.facture_id = f.id
           ), '[]'::jsonb) AS lines,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'due_date', e.due_date::text, 'label', e.label, 'amount', e.amount_due::text
             ) ORDER BY e.due_date, e.id)
             FROM public.facture_echeance e WHERE e.facture_id = f.id
           ), '[]'::jsonb) AS due_dates
    FROM public.facture f
    LEFT JOIN public.clients c ON c.client_id = f.client_id
    WHERE f.id = $1
  `, [factureId]);
  const document = result.rows[0];
  if (!document) throw new HttpError(404, "FACTURE_NOT_FOUND", "Facture introuvable.");
  if (!document.preview_hash || !document.draft_reference) {
    throw new HttpError(409, "FACTURE_WORKFLOW_UNAVAILABLE", "Cette facture historique ne dispose pas d’un parcours de validation enregistré. Ouvrez sa fiche.");
  }
  return document;
}
