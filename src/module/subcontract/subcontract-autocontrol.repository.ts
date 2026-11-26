import type { PoolClient } from "pg";
import { HttpError } from "../../utils/httpError";
import { readSubcontractPredecessorsTx } from "../commande-fournisseur/repository/subcontract-purchase.repository";
import {
  hasFrozenMachiningAutocontrolPlan, readMachiningAutocontrolLots, recordSubcontractIssueAutocontrol, type QualityActor,
} from "../qualite/repository/quality-360.repository";

export async function bindSubcontractIssueAutocontrol(
  tx: PoolClient,
  input: {
    ofId: number; operationId: string; issueId: string; lotId: string;
    materialOriginId: string | null; quantity: number; unit: string;
  },
  actor: QualityActor,
) {
  const routes = (await tx.query<{ id: string; kind: string | null }>(
    "SELECT op.id::text,COALESCE((SELECT f->>'type_operation' " +
    "FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]')) f WHERE f->>'phase'=op.phase::text LIMIT 1),s.type_operation) AS kind " +
    "FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id " +
    "LEFT JOIN public.pieces_techniques_operations s ON s.id=op.source_piece_operation_id " +
    "WHERE op.of_id=$1 AND op.status::text<>'CANCELLED' " +
    "AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions rev WHERE rev.id=op.revision_id AND rev.statut='ACTIVE'))",
    [input.ofId],
  )).rows;
  const kinds = new Map(routes.map(route => [route.id, route.kind]));
  const seen = new Set<string>();
  const machiningPredecessors: string[] = [];
  const frontier = [input.operationId];
  for (let i = 0; i < frontier.length; i++) {
    const id = frontier[i];
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 1000 || !kinds.has(id)) {
      throw new HttpError(409, "SUBCONTRACT_ROUTE_INVALID", "Vérifiez la chaîne des opérations de l’OF avant le départ.");
    }
    const kind = kinds.get(id);
    if (["FRAISAGE", "TOURNAGE", "REPRISE"].includes(kind ?? "")) {
      if (await hasFrozenMachiningAutocontrolPlan(tx, input.ofId, id)) machiningPredecessors.push(id);
    } else if (id === input.operationId || kind !== "SOUS_TRAITANCE") {
      const predecessors = await readSubcontractPredecessorsTx(tx, id);
      frontier.push(...predecessors.map(operation => operation.id));
    }
  }
  if (!machiningPredecessors.length) return;

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
    ...input, originLotId, unambiguousOfOrigin: lots.length === 1, machiningPredecessors,
  }, actor);
}
