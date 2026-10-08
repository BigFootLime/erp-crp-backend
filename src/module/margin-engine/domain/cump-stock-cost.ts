import { readCumpPostingSource, type CumpJournalSource } from '../../stock/domain/cump-posting-source';
import { parseCumpDecimal as decimal, formatCumpDecimal as text } from '../../stock/domain/cump-decimal';
import { applyCumpTransition, CUMP_FORMULA_VERSION, normalizeCumpScope, type CumpReliability, type CumpScope, type CumpState } from '../../stock/domain/cump-valuation';
import type { MarginCostInput, MarginSourceReliability } from './margin-engine';

export type StockMarginCostRow = {
  key: string; category: MarginCostInput['category']; amount_ht: string | null;
  source_type: string; source_ref: string | null; observed_at: string | null;
  source_reliability: MarginSourceReliability; currency: string | null;
  quantity: string | null; source_document_type: string; source_document_ref: string;
  availability?: MarginCostInput['availability']; definition?: string;
};
type IssueEntry = {
  entry_id: string; article_id: string; owner_key: CumpScope['owner']; stock_unit: string;
  currency: string; kind: string; sequence: string; formula_version: string;
  quantity_delta: string; movement_value: string | null; reliability: CumpReliability; source_valid: boolean;
  source_snapshot: { before_state: CumpState; after_state: CumpState };
};
type ReturnCursor = {
  original_entry_id: string; owner_key: CumpScope['owner']; stock_unit: string; currency: string;
  quantity: string; value: string | null; source_valid: boolean;
};
export type CumpStockCostRow = {
  cost: StockMarginCostRow; mode: 'PREPARED' | 'ACTIVE'; initialized: boolean;
  reporting_currency: string; formula_version: string; last_sequence: string;
  journal: CumpJournalSource | null; article_pending: boolean; article_blocked: boolean;
  entries: IssueEntry[]; returns: ReturnCursor[];
};

const sameScope = (a: CumpScope, b: CumpScope) => JSON.stringify(a) === JSON.stringify(b);
const unknown = (cost: StockMarginCostRow, reason: string): StockMarginCostRow => ({
  ...cost, amount_ht: null, source_reliability: 'UNKNOWN', source_type: 'STOCK_CUMP_COST_UNRESOLVED',
  definition: `Coût Stock indisponible : ${reason}. Aucun prix courant ne remplace cette preuve.`,
});

/** A root with one proved physical line has one unambiguous OF cost owner.
 * Refuse multi-line allocation instead of guessing which line owns a return.
 * Current article quantities are not used to rewrite a former issue cost. */
export function resolveCumpStockCost(row: CumpStockCostRow, ofId: string): StockMarginCostRow {
  const cost = row.cost;
  const legacy = { ...cost, definition: cost.definition
    ?? 'Prix stock appliqué et déclaré sur la sortie physique ; CUMP non vérifié.' };
  const inactive = row.mode === 'PREPARED';
  const fail = (reason: string) => inactive ? legacy : unknown(cost, reason);
  if (!row.journal) return fail('journal de mouvement absent');
  const parsed = readCumpPostingSource(row.journal, row.reporting_currency);
  const posting = parsed.posting;
  if (!posting || !['ISSUE', 'SCRAP'].includes(posting.kind) || posting.reversalOfId
    || posting.transferId || posting.scopes.length !== 1) return fail('racine de sortie ambiguë');
  const root = row.journal.source_snapshot as Record<string, unknown>;
  const lines = root.lines as Record<string, unknown>[];
  if (root.source_document_type !== 'OF' || root.source_document_id !== ofId || lines.length !== 1
    || cost.source_document_type !== 'STOCK_MOVEMENT_LINE'
    || lines[0].line_id !== cost.source_document_ref
    || cost.source_ref !== posting.movementId || cost.source_reliability === 'UNKNOWN')
    return fail('affectation physique OF ou ligne non prouvée');
  const scope = posting.scopes[0].scope;
  try {
    const quantity = decimal(posting.scopes[0].quantity);
    if (cost.quantity === null || decimal(cost.quantity) !== quantity)
      return fail('quantité de la source divergente');
    // Exclusion is based on frozen physical ownership, never the current lot.
    if (scope.owner !== 'COMPANY') return {
      ...cost, availability: 'NOT_APPLICABLE', amount_ht: null, source_reliability: 'VERIFIED',
      source_type: 'CLIENT_OWNED_STOCK_EXCLUDED', source_ref: `stock-journal:${posting.movementId}`,
      definition: 'Stock fourni par le client, propriétaire figé sur la sortie : exclu du coût matière société.',
    };
    if (inactive) return legacy;
    if (cost.currency !== scope.currency) return unknown(cost, 'devise de la source divergente');
    if (!row.initialized || row.formula_version !== CUMP_FORMULA_VERSION)
      return unknown(cost, 'projection non initialisée ou formule incompatible');
    if (row.article_pending || row.article_blocked)
      return unknown(cost, 'projection en attente ou preuve article bloquée');
    if (row.entries.length !== 1) return unknown(cost, 'entrée financière non univoque');
    const entry = row.entries[0];
    const entryScope = normalizeCumpScope({ articleId: entry.article_id, owner: entry.owner_key,
      unit: entry.stock_unit, currency: entry.currency });
    if (!entry.source_valid || !sameScope(scope, entryScope) || entry.sequence !== posting.sequence
      || BigInt(entry.sequence) > BigInt(row.last_sequence) || entry.formula_version !== CUMP_FORMULA_VERSION
      || entry.kind !== posting.kind || decimal(entry.quantity_delta, true) !== -quantity
      || entry.movement_value === null || !['VERIFIED', 'DECLARED'].includes(entry.reliability))
      return unknown(cost, 'valeur de sortie ou lien au journal non prouvé');
    const originalValue = decimal(entry.movement_value);
    const calculated = applyCumpTransition(entry.source_snapshot.before_state, {
      scope, quantity: text(quantity), kind: posting.kind as 'ISSUE' | 'SCRAP',
      movementRef: `stock-valuation-entry:${entry.entry_id}`,
    });
    const after = entry.source_snapshot.after_state;
    if (calculated.movementValue === null || decimal(calculated.movementValue) !== originalValue
      || calculated.movementReliability !== entry.reliability
      || !sameScope(scope, normalizeCumpScope(after.scope))
      || decimal(calculated.after.quantity, true) !== decimal(after.quantity, true)
      || after.value === null || calculated.after.value === null
      || decimal(calculated.after.value) !== decimal(after.value)
      || calculated.after.reliability !== after.reliability)
      return unknown(cost, 'arithmétique du CUMP divergente de la preuve');
    let returnedQuantity = 0n, returnedValue = 0n;
    if (row.returns.length > 1) return unknown(cost, 'retours de plusieurs périmètres');
    if (row.returns.length === 1) {
      const returned = row.returns[0];
      const returnScope = normalizeCumpScope({ articleId: scope.articleId, owner: returned.owner_key,
        unit: returned.stock_unit, currency: returned.currency });
      if (!returned.source_valid || returned.original_entry_id !== entry.entry_id
        || !sameScope(scope, returnScope) || returned.value === null)
        return unknown(cost, 'curseur net des retours non prouvé');
      returnedQuantity = decimal(returned.quantity); returnedValue = decimal(returned.value);
      if (returnedQuantity > quantity || returnedValue > originalValue
        || (returnedQuantity === 0n && returnedValue !== 0n)
        || (returnedQuantity === quantity && returnedValue !== originalValue))
        return unknown(cost, 'retours hors des bornes de la sortie originale');
    }
    return { ...cost, amount_ht: text(originalValue - returnedValue), quantity: text(quantity - returnedQuantity),
      source_type: 'STOCK_CUMP_NET_ISSUE_COST', source_ref: `stock-valuation-entry:${entry.entry_id}`,
      source_reliability: entry.reliability,
      definition: 'Valeur de sortie prouvée par le journal Stock, moins les retours nets prouvés ; aucun coût unitaire courant recalculé.',
    };
  } catch { return unknown(cost, 'précision ou périmètre financier invalide'); }
}

export function resolveCumpStockCosts(rows: CumpStockCostRow[], ofId: string): StockMarginCostRow[] {
  if (rows.length > 10000) return [{
    key: `stock-cump-window:${ofId}`, category: 'MATERIAL', amount_ht: null, quantity: null,
    source_type: 'STOCK_CUMP_WINDOW_TOO_DENSE', source_ref: ofId, observed_at: null,
    source_reliability: 'UNKNOWN', currency: 'EUR', source_document_type: 'OF', source_document_ref: ofId,
    definition: 'Lecture Stock trop volumineuse ; aucun coût partiel publié.',
  }];
  return rows.map(row => resolveCumpStockCost(row, ofId));
}
