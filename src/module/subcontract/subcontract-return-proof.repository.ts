import type { PoolClient } from "pg";
import { HttpError } from "../../utils/httpError";
import { SUBCONTRACT_AUTOCONTROL_ISSUED, type AutocontrolProof } from "../qualite/domain/autocontrol-proof";

export const SUBCONTRACT_RETURN_VERIFIED = "SUBCONTRACT_RETURN_VERIFIED";

type RecordedReturn = {
  verdict: "CONFORME" | "NON_CONFORME";
  appearance: "OK" | "NOK";
  nonConformityId: string | null;
};

type ReturnSource = {
  originId: string;
  issueId: string;
  ofId: number;
  operationId: string;
  quantity: number;
  unit: string;
  lotCode: string;
  proofs: AutocontrolProof[];
  recorded?: RecordedReturn;
};

type Queryable = Pick<PoolClient, "query">;

export async function readSubcontractReturnSources(tx: Queryable, lineId: string) {
  return (await tx.query<ReturnSource>(
    "SELECT b.id::text AS \"originId\", issue.id::text AS \"issueId\",op.of_id::int AS \"ofId\", " +
    "op.id::text AS \"operationId\",b.quantity::float8,issue.unit,lot.lot_code AS \"lotCode\",evidence.proofs,checked.recorded " +
    "FROM public.reception_subcontract_origins b " +
    "JOIN public.subcontract_work_package_ledger issue ON issue.id=b.issue_event_id AND issue.package_id=b.package_id AND issue.event_type='ISSUE' " +
    "JOIN public.lots lot ON lot.id=issue.lot_id " +
    "JOIN public.reception_fournisseur_lignes l ON l.id=b.receipt_line_id " +
    "JOIN public.subcontract_work_package_ledger ret ON ret.id=b.return_event_id AND ret.package_id=b.package_id AND ret.event_type='RETURN' AND ret.lot_id=l.lot_id " +
    "JOIN public.subcontract_work_packages p ON p.id=b.package_id AND p.supplier_order_line_id=l.commande_fournisseur_ligne_id " +
    "JOIN public.of_operations op ON op.id=p.of_operation_id " +
    "JOIN LATERAL (SELECT jsonb_agg(ev.new_values->'proof' ORDER BY ev.id) AS proofs FROM public.quality_event_log ev " +
    "WHERE ev.entity_type='CONTROL' AND ev.event_type=$2 AND ev.new_values->>'issueId'=issue.id::text " +
    "AND ev.new_values->>'lotId'=issue.lot_id::text AND ev.new_values->>'operationId'=op.id::text " +
    "AND ev.new_values->'proof'->>'ofId'=op.of_id::text) evidence ON evidence.proofs IS NOT NULL " +
    "LEFT JOIN LATERAL (SELECT ev.details AS recorded FROM public.reception_processing_events ev " +
    "WHERE ev.receipt_line_id=b.receipt_line_id AND ev.event_type=$3 AND ev.details->>'sourceIssueId'=issue.id::text " +
    "ORDER BY ev.created_at DESC,ev.id LIMIT 1) checked ON true " +
    "WHERE b.receipt_line_id=$1::uuid ORDER BY issue.created_at,issue.id",
    [lineId, SUBCONTRACT_AUTOCONTROL_ISSUED, SUBCONTRACT_RETURN_VERIFIED],
  )).rows;
}

export async function assertSubcontractReturnVerified(tx: Queryable, lineId: string, originId?: string) {
  const sources = await readSubcontractReturnSources(tx, lineId);
  if (sources.some(source => (!originId || source.originId === originId) && !source.recorded)) {
    throw new HttpError(409, "SUBCONTRACT_RETURN_CONTROL_REQUIRED",
      "Vérifiez l’aspect du retour de traitement avant de continuer.");
  }
}
