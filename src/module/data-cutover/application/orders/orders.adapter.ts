import { HttpError } from "../../../../utils/httpError";
import { repoCreateCommandeCutoverDraftTx } from "../../../commande-client/repository/commande-client.repository";
import { repoCreateCommandeFournisseurTx } from "../../../commande-fournisseur/repository/commande-fournisseur.repository";
import { createCommandeBodySchema } from "../../../commande-client/validators/commande-client.validators";
import { createCommandeSchema } from "../../../commande-fournisseur/validators/commande-fournisseur.validators";
import type { ApplicationAdapter, ApplicationContext, AppliedApplicationTarget, ResolvedApplicationTarget } from "../application.types";
import { buildOrderRemainderDraftsTx, type OrderReferenceResolverTx } from "./orders.contract";
import { applicationInputIssues } from "../application.errors";
import type { CutoverRow } from "../../types/data-cutover.types";

const target = (context: ApplicationContext, kind: string, key: string): ResolvedApplicationTarget | null => context.targets.get(`${kind}:${key}`) ?? null;
const resolver = (context: ApplicationContext): OrderReferenceResolverTx => ({
  customerId: async (_tx, code) => target(context, "CUSTOMER", code)?.id ?? null,
  supplierId: async (_tx, code) => target(context, "SUPPLIER", code)?.id ?? null,
  articleId: async (_tx, code) => target(context, "ARTICLE", code)?.id ?? null,
});
function assertExplicitTargets(context: ApplicationContext) {
  for (const row of context.rows) for (const [field, kind] of [["customerTargetId", "CUSTOMER"], ["supplierTargetId", "SUPPLIER"], ["articleTargetId", "ARTICLE"]]) {
    const value = row.values[field];
    if (typeof value !== "string" || !value.trim()) continue;
    if (![...context.targets.values()].some((target) => target.type === kind && target.id === value.trim() && !target.planned)) throw new HttpError(422, "CUTOVER_ORDER_TARGET_UNCONFIRMED", "Une cible CERP choisie n'est plus disponible. Sélectionner à nouveau la fiche avant de poursuivre.");
  }
}
function partnerGroup(row: CutoverRow, kind: string, sourceField: string, targetField: string, targets?: ReadonlyMap<string, ResolvedApplicationTarget>) {
  const explicit = String(row.values[targetField] ?? "").trim();
  const legacy = String(row.values[sourceField] ?? "").trim();
  const resolved = explicit || targets?.get(`${kind}:${legacy}`)?.id;
  return resolved ? `NATIVE:${resolved}` : `LEGACY:${legacy}`;
}
const number = (value: string | null, label: string) => {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) throw new HttpError(422, "CUTOVER_ORDER_PRICE_REQUIRED", `${label} doit etre confirme avant creation.`);
  return Number(value);
};
const totals = (lines: Array<{ quantity: string; unitPrice: string | null; vatRate: string | null }>) => {
  const totalHt = lines.reduce((sum, line) => sum + number(line.quantity, "Le reliquat") * number(line.unitPrice, "Le prix accepte"), 0);
  const totalTtc = lines.reduce((sum, line) => sum + number(line.quantity, "Le reliquat") * number(line.unitPrice, "Le prix accepte") * (1 + number(line.vatRate, "La TVA") / 100), 0);
  return { total_ht: Math.round(totalHt * 100) / 100, total_ttc: Math.round(totalTtc * 100) / 100 };
};
const audit = (user_id: number) => ({ user_id, role: "SuperAdmin", ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null });

/**
 * Creates only native draft orders. It deliberately has no delivery, stock, OF,
 * notification, document or external side effects. Durable crosswalk claims are
 * created by the parent cutover orchestration in the same transaction.
 */
export const cutoverOrdersAdapter: ApplicationAdapter = {
  domains: ["SALES_ORDER", "SUPPLIER_ORDER", "INTERNAL_DEMAND"], kind: "ORDER_REMAINDER_DRAFT", mode: "CREATE", effects: [],
  groupKey: (row, targets) => {
    const v = row.values;
    if (row.domain === "SALES_ORDER") return `CUSTOMER:${partnerGroup(row, "CUSTOMER", "customerCode", "customerTargetId", targets)}:${String(v.customerOrderNumber ?? "").trim()}`;
    if (row.domain === "SUPPLIER_ORDER") return `SUPPLIER:${partnerGroup(row, "SUPPLIER", "supplierCode", "supplierTargetId", targets)}:${String(v.supplierOrderNumber ?? "").trim()}`;
    return `INTERNAL:${row.id}`;
  },
  async inspect(context) {
    try {
      assertExplicitTargets(context);
      const drafts = await buildOrderRemainderDraftsTx({ tx: context.client, rows: context.rows, resolver: resolver(context) });
      for (const draft of drafts) {
        if (draft.kind === "CUSTOMER") {
          const row = context.rows.find((entry) => entry.id === draft.lines[0]?.rowId)!;
          const customer = target(context, "CUSTOMER", String(row.values.customerCode ?? "").trim());
          if (!customer && !String(row.values.customerTargetId ?? "").trim()) throw new HttpError(422, "CUTOVER_ORDER_CUSTOMER_UNRESOLVED", "Le client CERP doit etre rapproche explicitement avant creation.");
          if (draft.currency !== "EUR") throw new HttpError(422, "CUTOVER_ORDER_CURRENCY_UNSUPPORTED", "La commande client native ne porte pas de devise; une commande non EUR ne peut pas etre reprise sans evolution du modele.");
          // A release must use the dedicated native contract-call flow, which needs a
          // contract version and idempotency key. It is blocked until that adapter exists.
          if (draft.classification.kind === "CADRE_RELEASE") throw new HttpError(422, "CUTOVER_ORDER_CONTRACT_RELEASE_UNAVAILABLE", "Un appel de contrat doit passer par le flux natif d'appel avec version du contrat; aucune commande cadre approximative n'est creee.");
          createCommandeBodySchema.parse({ order_type: "FERME", client_id: draft.customerId, code_client: draft.customerOrderNumber, date_commande: draft.orderDate, save_intent: "DRAFT", commentaire: "Reprise de commande - brouillon", ...totals(draft.lines), lignes: draft.lines.map((line) => ({ article_id: line.articleId, designation: line.articleReference, quantite: number(line.quantity, "Le reliquat"), prix_unitaire_ht: number(line.unitPrice, "Le prix accepte"), taux_tva: number(line.vatRate, "La TVA"), unite: line.unit, delai_client: line.plannedDueDate })) });
        } else if (draft.kind === "SUPPLIER") {
          createCommandeSchema.parse({ body: { fournisseur_id: draft.supplierId, origine: "AUTRE", devise: draft.currency, note_interne: `Reprise - BC ${draft.supplierOrderNumber}; date source ${draft.orderDate}`, lignes: draft.lines.map((line) => ({ type: "ARTICLE", article_id: line.articleId, designation: line.articleReference, unite: line.unit, quantite: number(line.quantity, "Le reliquat"), prix_unitaire_ht: number(line.unitPrice, "Le prix accepte"), tva_pct: number(line.vatRate, "La TVA"), date_besoin: line.plannedDueDate })) } });
        } else {
          // An internal demand is not a customer sale: price and VAT are
          // deliberately neutral, never inferred from an old commercial file.
          createCommandeBodySchema.parse({ order_type: "INTERNE", date_commande: draft.orderDate, save_intent: "DRAFT", commentaire: `Reprise - besoin interne ${draft.historicalReference}`, total_ht: 0, total_ttc: 0, lignes: draft.lines.map((line) => ({ article_id: line.articleId, designation: line.articleReference, quantite: number(line.quantity, "Le reliquat"), prix_unitaire_ht: 0, taux_tva: 0, unite: line.unit, delai_client: line.plannedDueDate })) });
        }
      }
      return [];
    } catch (error) {
      return applicationInputIssues(error, context.rows[0]?.id);
    }
  },
  async apply(context) {
    const blockers = await this.inspect(context);
    if (blockers.length) throw new HttpError(422, blockers[0]!.code, blockers[0]!.message);
    const drafts = await buildOrderRemainderDraftsTx({ tx: context.client, rows: context.rows, resolver: resolver(context) });
    const targets: AppliedApplicationTarget[] = [];
    for (const draft of drafts) {
      if (draft.kind === "CUSTOMER") {
        const row = context.rows.find((entry) => entry.id === draft.lines[0]?.rowId)!;
        const input = createCommandeBodySchema.parse({ order_type: "FERME", client_id: draft.customerId, code_client: draft.customerOrderNumber, date_commande: draft.orderDate, save_intent: "DRAFT", commentaire: `Reprise CLIPPER/Excel - PO ${draft.customerOrderNumber}; references: ${draft.historicalReferences.join(", ")}`, ...totals(draft.lines), lignes: draft.lines.map((line) => ({ article_id: line.articleId, designation: line.articleReference, quantite: number(line.quantity, "Le reliquat"), prix_unitaire_ht: number(line.unitPrice, "Le prix accepte"), taux_tva: number(line.vatRate, "La TVA"), unite: line.unit, delai_client: line.plannedDueDate })) });
        const result = await repoCreateCommandeCutoverDraftTx(context.client, input, context.actorId);
        for (const line of draft.lines) targets.push({ rowId: line.rowId, domain: "SALES_ORDER", targetType: "COMMANDE_CLIENT", targetId: String(result.id), targetReference: result.numero });
      } else if (draft.kind === "SUPPLIER") {
        const body = createCommandeSchema.parse({ body: { fournisseur_id: draft.supplierId, origine: "AUTRE", devise: draft.currency, note_interne: `Reprise CLIPPER/Excel - BC ${draft.supplierOrderNumber}; date source ${draft.orderDate}; references: ${draft.historicalReferences.join(", ")}`, lignes: draft.lines.map((line) => ({ type: "ARTICLE", article_id: line.articleId, designation: line.articleReference, unite: line.unit, quantite: number(line.quantity, "Le reliquat"), prix_unitaire_ht: number(line.unitPrice, "Le prix accepte"), tva_pct: number(line.vatRate, "La TVA"), date_besoin: line.plannedDueDate })) } }).body;
        const result = await repoCreateCommandeFournisseurTx(body, audit(context.actorId), context.client, { sideEffects: "none" });
        for (const line of draft.lines) targets.push({ rowId: line.rowId, domain: "SUPPLIER_ORDER", targetType: "COMMANDE_FOURNISSEUR", targetId: result.id, targetReference: result.code });
      } else {
        const input = createCommandeBodySchema.parse({ order_type: "INTERNE", date_commande: draft.orderDate, save_intent: "DRAFT", commentaire: `Reprise CLIPPER/Excel - besoin interne ${draft.historicalReference}`, total_ht: 0, total_ttc: 0, lignes: draft.lines.map((line) => ({ article_id: line.articleId, designation: line.articleReference, quantite: number(line.quantity, "Le reliquat"), prix_unitaire_ht: 0, taux_tva: 0, unite: line.unit, delai_client: line.plannedDueDate })) });
        const result = await repoCreateCommandeCutoverDraftTx(context.client, input, context.actorId);
        for (const line of draft.lines) targets.push({ rowId: line.rowId, domain: "INTERNAL_DEMAND", targetType: "BESOIN_INTERNE", targetId: String(result.id), targetReference: result.numero });
      }
    }
    return { targets };
  },
};
