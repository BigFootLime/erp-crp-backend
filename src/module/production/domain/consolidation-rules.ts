import { HttpError } from "../../../utils/httpError";
export type ConsolidationSource = {
  id: number;
  numero: string;
  priority?: string;
  client_id: string | null;
  article_id: string | null;
  piece_technique_id: string;
  piece_technique_version_id: string | null;
  technical_snapshot_sha256: string | null;
  quantite_lancee: number;
  quantite_bonne: number;
  quantite_rebut: number;
  statut: string;
  technical_readiness: string;
  planned_count: number;
  started_count: number;
  covered: boolean;
  producer: boolean;
  updated_at: string;
  planning_wait_started_at: string | null;
  date_fin_prevue: string | null;
  parent_of_id: number | null;
  root_of_id: number | null;
  technical_snapshot: unknown;
};
export function buildConsolidationPlan(
  sources: ConsolidationSource[],
  surplus: number,
) {
  if (
    sources.length < 2 ||
    new Set(sources.map((s) => s.id)).size !== sources.length
  )
    throw new HttpError(
      422,
      "CONSOLIDATION_SOURCES",
      "Sélectionnez au moins deux OF distincts.",
    );
  const first = sources[0];
  const problems: Array<{ of_id: number; numero: string; reasons: string[] }> =
    [];
  for (const s of sources) {
    const reasons: string[] = [];
    if (!s.client_id || s.client_id !== first.client_id)
      reasons.push("Client différent ou absent");
    if (!s.article_id || s.article_id !== first.article_id)
      reasons.push("Article différent ou absent");
    if (
      s.piece_technique_id !== first.piece_technique_id ||
      !s.piece_technique_version_id ||
      s.piece_technique_version_id !== first.piece_technique_version_id
    )
      reasons.push("Définition ou indice différent");
    if (
      !s.technical_snapshot_sha256 ||
      s.technical_snapshot_sha256 !== first.technical_snapshot_sha256
    )
      reasons.push("Gamme, achats ou exigences techniques différents");
    if (s.statut !== "BROUILLON" || s.technical_readiness !== "VALIDATED")
      reasons.push("OF à préparer avant regroupement");
    if (
      s.planned_count > 0 ||
      s.started_count > 0 ||
      s.quantite_bonne > 0 ||
      s.quantite_rebut > 0
    )
      reasons.push("OF déjà engagé");
    if (s.covered || s.producer)
      reasons.push("OF déjà membre ou producteur d’un regroupement");
    if (!Number.isFinite(s.quantite_lancee) || s.quantite_lancee <= 0)
      reasons.push("Quantité invalide");
    if (reasons.length)
      problems.push({ of_id: s.id, numero: s.numero, reasons });
  }
  if (problems.length)
    throw new HttpError(
      422,
      "CONSOLIDATION_INCOMPATIBLE",
      "Les OF sélectionnés ne sont pas compatibles.",
      { sources: problems },
    );
  if (!Number.isFinite(surplus) || surplus < 0)
    throw new HttpError(422, "CONSOLIDATION_QUANTITY", "Surplus invalide.");
  // OF quantities are already net of stock at generation. Never subtract that stock again.
  const demandMilli = sources.reduce(
    (sum, s) => sum + Math.round(s.quantite_lancee * 1000),
    0,
  );
  const quantity = (demandMilli + Math.round(surplus * 1000)) / 1000;
  const wait =
    sources
      .map((s) => s.planning_wait_started_at)
      .filter((d): d is string => d !== null)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  return {
    quantity,
    demand_quantity: demandMilli / 1000,
    surplus_quantity: surplus,
    planning_wait_started_at: wait,
    allocations: sources.map((s) => ({
      source_of_id: s.id,
      numero: s.numero,
      quantity: s.quantite_lancee,
      due_date: s.date_fin_prevue,
      parent_of_id: s.parent_of_id,
      root_of_id: s.root_of_id,
    })),
  };
}

export function allocateReceivedQuantity(
  allocations: readonly {
    id: string;
    quantity: number;
    received_quantity: number;
    due_date: string | null;
  }[],
  received: number,
) {
  let remaining = Math.round(received * 1000);
  const result: Array<{ allocation_id: string; quantity: number }> = [];
  for (const a of [...allocations].sort(
    (a, b) =>
      (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") ||
      a.id.localeCompare(b.id),
  )) {
    const qty = Math.min(
      remaining,
      Math.max(0, Math.round((a.quantity - a.received_quantity) * 1000)),
    );
    if (qty > 0) {
      result.push({ allocation_id: a.id, quantity: qty / 1000 });
      remaining -= qty;
    }
  }
  return { allocations: result, surplus: remaining / 1000 };
}
