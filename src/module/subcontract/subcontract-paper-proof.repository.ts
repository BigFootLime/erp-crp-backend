import type { PoolClient } from "pg";
import { HttpError } from "../../utils/httpError";
import { readBlob } from "../ged/services/ged-vault.service";
import type { AutocontrolProof } from "../qualite/domain/autocontrol-proof";
import type { PaperDepartureAttestation } from "./subcontract-input.validators";

export const PAPER_SUBCONTRACT_ISSUE_COMMAND = "SUBCONTRACT_ISSUE_PAPER_PROOF";

export type PaperDepartureProof = Omit<AutocontrolProof, "controlId" | "documentId" | "documentSha256" | "mode" | "snapshotSha256"> & {
  source: "GED_OF";
  mode: "PAPER";
  controlId?: never;
  documentId: string;
  documentSha256: string;
};

type Db = Pick<PoolClient, "query">;
const MAX_SCAN_BYTES = 25 * 1024 * 1024;

async function readWorkshopPaperScans(tx: Db, ofId: number, versionId: string | null = null, lock = false, historical = false) {
  return (await tx.query<{
    version_id: string; label: string; storage_key: string; sha256: string; size: number; mime_type: string;
  }>(
    "SELECT v.id::text AS version_id,d.title AS label,b.storage_key,b.sha256,b.size_bytes::int AS size,b.mime_type " +
    "FROM public.ged_document_versions v JOIN public.ged_documents d ON d.id=v.document_id " +
    "JOIN public.ged_blobs b ON b.id=v.blob_id JOIN public.ged_upload_sessions s ON s.id=v.upload_session_id " +
    "WHERE d.class_key='RELEVE_CONTROLE' AND (($3::boolean AND v.status IN ('APPLICABLE','OBSOLETE')) " +
    "OR (d.archived_at IS NULL AND v.status='APPLICABLE' AND d.current_version_id=v.id)) " +
    "AND s.document_id=d.id AND s.scan_status='clean' AND s.quarantine_status='released' AND s.sha256=b.sha256 " +
    "AND s.size_bytes=b.size_bytes AND s.mime_type=b.mime_type AND b.mime_type='application/pdf' AND b.size_bytes BETWEEN 1 AND $4 " +
    "AND NOT EXISTS (SELECT 1 FROM public.ged_document_links restricted WHERE restricted.document_id=d.id AND restricted.entity_type='CUTOVER_ROW') " +
    "AND ($2::uuid IS NULL OR v.id=$2) AND ($3::boolean OR EXISTS (SELECT 1 FROM public.ged_document_links l " +
    "WHERE l.document_id=d.id AND l.entity_type='ORDRE_FABRICATION' AND l.entity_id=$1::bigint::text AND l.link_role='RELEVE_CONTROLE_REALISE')) " +
    "ORDER BY v.created_at DESC,v.id DESC LIMIT 100" + (lock ? " FOR SHARE OF d,v" : ""),
    [ofId, versionId, historical, MAX_SCAN_BYTES],
  )).rows;
}

export async function listWorkshopPaperScans(tx: Db, ofId: number) {
  return (await readWorkshopPaperScans(tx, ofId)).map(({ version_id, label }) => ({ version_id, label }));
}

export async function readPinnedWorkshopPaperScan(tx: Db, proof: PaperDepartureProof) {
  const [scan] = await readWorkshopPaperScans(tx, proof.ofId, proof.documentId, false, true);
  if (!scan || scan.sha256 !== proof.documentSha256) {
    throw new HttpError(409, "SUBCONTRACT_RETURN_SCAN_UNAVAILABLE", "La fiche vérifiée au départ n’est plus disponible. Contactez Qualité.");
  }
  const bytes = await readBlob(scan.storage_key, scan.sha256);
  if (bytes.length !== scan.size) throw new HttpError(409, "GED_INTEGRITY", "La taille de la fiche GED ne correspond plus à sa version.");
  return { bytes, mimeType: scan.mime_type };
}

export async function confirmPaperSubcontractIssue(tx: Db, input: {
  issueId: string; lotId: string; originLotId: string; operationId: string; ofId: number;
  quantity: number; unit: string; proofHash: string; actorId: number;
  required: string[]; attestations: PaperDepartureAttestation[];
}) {
  const byOperation = new Map(input.attestations.map(value => [value.operation_id, value]));
  if (byOperation.size !== input.attestations.length || byOperation.size !== input.required.length ||
    input.required.some(op => !byOperation.has(op))) {
    throw new HttpError(422, "SUBCONTRACT_PAPER_FORM_REQUIRED", "Attestez une fiche manuscrite pour chaque opération d’usinage sans plan figé.");
  }
  const { population, confirmed_at } = (await tx.query<{ population: number; confirmed_at: string }>(
    "SELECT quantite_lancee::float8 AS population,statement_timestamp()::text AS confirmed_at FROM public.ordres_fabrication WHERE id=$1",
    [input.ofId],
  )).rows[0];
  const proofs: PaperDepartureProof[] = [];
  for (const operationId of input.required) {
    const attestation = byOperation.get(operationId)!;
    const [scan] = await readWorkshopPaperScans(tx, input.ofId, attestation.document_version_id, true);
    if (!scan) throw new HttpError(409, "SUBCONTRACT_PAPER_SCAN_SCOPE",
      "Déposez un PDF d’autocontrôle rempli dans cet OF, puis attendez la validation de son scan.");
    const bytes = await readBlob(scan.storage_key, scan.sha256);
    if (bytes.length !== scan.size) throw new HttpError(409, "GED_INTEGRITY", "La taille de la fiche GED ne correspond plus à sa version.");
    const usage = (await tx.query<{ used: number; other_lot: boolean }>(
      "SELECT COALESCE(sum((c.response->>'quantity')::numeric),0)::float8 AS used," +
      "COALESCE(bool_or(c.response->>'originLotId' IS DISTINCT FROM $5),false) AS other_lot " +
      "FROM public.consumable_commands c CROSS JOIN LATERAL jsonb_array_elements(c.response->'proofs') proof " +
      "WHERE c.command_type=$1 AND c.of_id=$2 AND proof->>'operationId'=$3 AND proof->>'documentSha256'=$4",
      [PAPER_SUBCONTRACT_ISSUE_COMMAND, input.ofId, operationId, scan.sha256, input.originLotId],
    )).rows[0];
    if (usage.other_lot || attestation.conforming_qty > population || usage.used + input.quantity > attestation.conforming_qty) {
      throw new HttpError(409, "SUBCONTRACT_PAPER_QUANTITY", "La quantité attestée sur ce relevé doit couvrir les pièces de ce lot, départs précédents inclus.");
    }
    proofs.push({
      source: "GED_OF", mode: "PAPER", ofId: input.ofId, operationId, lotId: input.originLotId,
      documentId: scan.version_id, documentSha256: scan.sha256, contentSha256: scan.sha256,
      confirmedAt: new Date(confirmed_at).toISOString(), conformingQuantity: attestation.conforming_qty,
      unit: input.unit, measurements: [],
    });
  }
  await tx.query("INSERT INTO public.consumable_commands(idempotency_key,actor_id,of_id,command_type,request_hash,response) " +
    "VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb)", [
    input.issueId, input.actorId, input.ofId, PAPER_SUBCONTRACT_ISSUE_COMMAND, input.proofHash,
    JSON.stringify({ lotId: input.lotId, originLotId: input.originLotId, operationId: input.operationId, quantity: input.quantity, proofs }),
  ]);
  return proofs.map(({ operationId, documentId, documentSha256, conformingQuantity }) => ({
    operationId, documentId, documentSha256, conformingQuantity,
  }));
}
