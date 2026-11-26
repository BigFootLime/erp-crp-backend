import type { PoolClient } from "pg";
import { HttpError } from "../../utils/httpError";
import { qualitySha256 } from "../qualite/domain/quality-policy";
import { readSubcontractPredecessorsTx } from "../commande-fournisseur/repository/subcontract-purchase.repository";
import {
  hasFrozenMachiningAutocontrolPlan, readMachiningAutocontrolLots, recordSubcontractIssueAutocontrol, type QualityActor,
} from "../qualite/repository/quality-360.repository";
import { confirmPaperSubcontractIssue, listWorkshopPaperScans, PAPER_SUBCONTRACT_ISSUE_COMMAND } from "./subcontract-paper-proof.repository";
import type { PaperDepartureAttestation } from "./subcontract-input.validators";

type Db = Pick<PoolClient, "query">;

async function getMachiningProofRoute(tx: Db, ofId: number, operationId: string) {
  const routes = (await tx.query<{ id: string; phase: number; label: string; kind: string | null }>(
    "SELECT op.id::text,op.phase::int,op.designation AS label,COALESCE((SELECT f->>'type_operation' " +
    "FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]')) f WHERE f->>'phase'=op.phase::text LIMIT 1),s.type_operation) AS kind " +
    "FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id " +
    "LEFT JOIN public.pieces_techniques_operations s ON s.id=op.source_piece_operation_id " +
    "WHERE op.of_id=$1 AND op.status::text<>'CANCELLED' " +
    "AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions rev WHERE rev.id=op.revision_id AND rev.statut='ACTIVE'))",
    [ofId],
  )).rows;
  const byId = new Map(routes.map(route => [route.id, route]));
  const seen = new Set<string>();
  const planned: Array<typeof routes[number]> = [];
  const paper: Array<typeof routes[number]> = [];
  const frontier = [operationId];
  for (let i = 0; i < frontier.length; i++) {
    const id = frontier[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const current = byId.get(id);
    if (seen.size > 1000 || !current) {
      throw new HttpError(409, "SUBCONTRACT_ROUTE_INVALID", "Vérifiez la chaîne des opérations de l’OF avant le départ.");
    }
    if (["FRAISAGE", "TOURNAGE", "REPRISE"].includes(current.kind ?? "")) {
      const target = await hasFrozenMachiningAutocontrolPlan(tx, ofId, id) ? planned : paper;
      target.push(current);
    } else if (id === operationId || current.kind !== "SOUS_TRAITANCE") {
      const predecessors = await readSubcontractPredecessorsTx(tx, id);
      frontier.push(...predecessors.map(operation => operation.id));
    }
  }
  return { planned, paper };
}

export async function getPaperSubcontractAttestationOptions(tx: Db, operationId: string) {
  const { of_id } = (await tx.query<{ of_id: number }>(
    "SELECT of_id::int FROM public.of_operations WHERE id=$1::uuid", [operationId],
  )).rows[0] ?? {};
  if (!of_id) return undefined;
  const { paper } = await getMachiningProofRoute(tx, of_id, operationId);
  if (!paper.length) return undefined;
  return {
    of_id,
    operations: paper.map(({ id, phase, label }) => ({ id, phase, label })),
    documents: await listWorkshopPaperScans(tx, of_id),
  };
}

export function hashPaperSubcontractAttestations(attestations: readonly PaperDepartureAttestation[]) {
  return attestations.length ? qualitySha256([...attestations].sort((a, b) => a.operation_id.localeCompare(b.operation_id))) : null;
}

export async function readPaperSubcontractIssueHash(tx: Db, issueId: string) {
  return (await tx.query<{ request_hash: string }>(
    "SELECT request_hash FROM public.consumable_commands WHERE idempotency_key=$1::uuid AND command_type=$2",
    [issueId, PAPER_SUBCONTRACT_ISSUE_COMMAND],
  )).rows[0]?.request_hash ?? null;
}

export async function bindSubcontractIssueAutocontrol(
  tx: PoolClient,
  input: {
    ofId: number; operationId: string; issueId: string; lotId: string;
    materialOriginId: string | null; quantity: number; unit: string;
    paperAttestations?: PaperDepartureAttestation[];
  },
  actor: QualityActor,
) {
  const { planned, paper } = await getMachiningProofRoute(tx, input.ofId, input.operationId);
  const attestations = input.paperAttestations ?? [];
  const proofHash = hashPaperSubcontractAttestations(attestations);
  if (!paper.length && proofHash) {
    throw new HttpError(422, "SUBCONTRACT_PAPER_SCOPE", "Utilisez la fiche d’autocontrôle de l’opération dotée d’un plan figé.");
  }
  if (paper.length && !proofHash) {
    throw new HttpError(422, "SUBCONTRACT_PAPER_FORM_REQUIRED", "Attestez une fiche manuscrite pour chaque opération d’usinage sans plan figé.");
  }
  if (!planned.length && !paper.length) return [];

  const lots = await readMachiningAutocontrolLots(tx, input.ofId);
  const matching = (await tx.query<{ id: string }>(
    "WITH RECURSIVE ancestry(id) AS (SELECT $1::uuid UNION SELECT e.parent_lot_id " +
    "FROM ancestry a JOIN public.stock_lot_genealogy_edges e ON e.child_lot_id=a.id) " +
    "SELECT id::text FROM ancestry WHERE id=ANY($2::uuid[])",
    [input.lotId, lots.map(lot => lot.id)],
  )).rows.map(row => row.id);
  const requestedOrigin = input.materialOriginId ?? (matching.includes(input.lotId) ? input.lotId : null);
  const originLotId = requestedOrigin
    ? matching.find(id => id === requestedOrigin)
    : matching.length === 1 ? matching[0] : undefined;
  if (!originLotId) throw new HttpError(409, "SUBCONTRACT_AUTOCONTROL_LOT_UNVERIFIED",
    "L’origine de ce lot doit être reliée sans ambiguïté à l’OF avant le départ.");
  await recordSubcontractIssueAutocontrol(tx, {
    ...input, originLotId, unambiguousOfOrigin: lots.length === 1, machiningPredecessors: planned.map(op => op.id),
  }, actor);
  return proofHash ? confirmPaperSubcontractIssue(tx, {
    ...input, actorId: actor.user_id, originLotId, proofHash, required: paper.map(op => op.id), attestations,
  }) : [];
}
