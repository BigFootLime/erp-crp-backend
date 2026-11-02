import { HttpError } from "../../../utils/httpError";
import { frozenYieldGoodOutputNumber } from "./frozen-yield";
export type ConsolidationSource = {
  id: number;
  numero: string;
  priority?: string;
  client_id: string | null;
  article_id: string | null;
  unit: string;
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
  /** Immutable execution snapshot for pilot OFs. Absent on historical/manual OFs. */
  industrial_semantics?: unknown | null;
};

type GoodOutputSemantics = {
  coverage_semantics: "GOOD_OUTPUT_V1";
  launched_quantity: string | number;
  required_good_quantity: string | number;
  expected_good_quantity: string | number;
  yield_percent: string | number;
};

const milli = (quantity: number) => Math.round(quantity * 1000);

/**
 * The launched quantity remains the physical quantity for load and material.
 * An industrial OF, however, can carry an immutable forecast of its good
 * output.  Only that good output can be promised to its commercial source.
 * Old/manual OFs deliberately retain their former (launched = good) meaning.
 */
export function sourceCommercialQuantity(source: ConsolidationSource): number {
  if (
    source.industrial_semantics === undefined ||
    source.industrial_semantics === null
  )
    return source.quantite_lancee;
  const token = source.industrial_semantics as Partial<GoodOutputSemantics>;
  if (token.coverage_semantics !== "GOOD_OUTPUT_V1")
    throw new HttpError(
      422,
      "CONSOLIDATION_YIELD_INVALID",
      "Le rendement figé de l’OF est illisible.",
      { of_id: source.id },
    );
  const originalLaunched = Number(token.launched_quantity);
  const required = Number(token.required_good_quantity);
  const expected = Number(token.expected_good_quantity);
  const yieldPercent = Number(token.yield_percent);
  if (
    !Number.isFinite(originalLaunched) ||
    originalLaunched <= 0 ||
    !Number.isFinite(required) ||
    required <= 0 ||
    !Number.isFinite(expected) ||
    expected <= 0 ||
    !Number.isFinite(yieldPercent) ||
    yieldPercent <= 0 ||
    yieldPercent > 100 ||
    expected > originalLaunched
  )
    throw new HttpError(
      422,
      "CONSOLIDATION_YIELD_INVALID",
      "Le rendement figé de l’OF ne permet pas de promettre une quantité conforme.",
      { of_id: source.id },
    );
  // Recalculate from the *current* gross quantity with the frozen rate. A
  // manual decrease therefore reduces good coverage; an increase cannot turn
  // the original firm need or the frozen expected output into a new promise.
  const projected = frozenYieldGoodOutputNumber({
    launched: source.quantite_lancee,
    yieldPercent,
    unit: source.unit,
  });
  const good = Math.min(required, expected, projected);
  if (good <= 0)
    throw new HttpError(
      422,
      "CONSOLIDATION_YIELD_ZERO_GOOD_OUTPUT",
      "Le rendement figé de l’OF ne permet aucune pièce conforme à affecter au regroupement.",
      { of_id: source.id },
    );
  return good;
}
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
  // `quantity` is the physical/brut quantity: it sizes the gamme and BOM.
  // Allocations are good pieces only, so a 112-brut/100-bon pilot OF never
  // promises its 12-piece yield margin a second time after consolidation.
  const launchedMilli = sources.reduce(
    (sum, s) => sum + milli(s.quantite_lancee),
    0,
  );
  const demandMilli = sources.reduce(
    (sum, s) => sum + milli(sourceCommercialQuantity(s)),
    0,
  );
  const quantity = (launchedMilli + milli(surplus)) / 1000;
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
      quantity: sourceCommercialQuantity(s),
      launched_quantity: s.quantite_lancee,
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
