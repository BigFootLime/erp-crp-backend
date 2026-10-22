import { HttpError } from "../../../../utils/httpError";
import type { ApplicationAdapter, ApplicationContext } from "../application.types";
import { applyFinanceOpeningsTx, applyOpeningStockTx, applyWipOpeningTx, assertOpeningRowsReady, assertOpeningStockInputs, resolveOpeningPfTechnicalVersionTx } from "./openings.contract";
import type { CutoverIssue } from "../../types/data-cutover.types";
import { inspectNativeWipPreparationTx } from "./wip-native.adapter";

const issue = (rowId: string, error: unknown): CutoverIssue & { row_id?: string } => ({
  row_id: rowId, field: null,
  code: error instanceof HttpError ? error.code : "CUTOVER_OPENING_UNAVAILABLE",
  message: error instanceof HttpError ? error.message : "Cette ouverture ne peut pas être contrôlée pour le moment.",
});
const audit = (context: ApplicationContext) => ({ user_id: context.actorId, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "/administration/importation", page_key: "data-cutover", client_session_id: context.correlationId });
const text = (context: ApplicationContext, rowId: string, field: string) => {
  const row = context.rows.find((item) => item.id === rowId);
  const value = row?.values[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};
function targetFor(context: ApplicationContext, rowId: string, field: string, domain: string, legacyField?: string, acceptedTypes: string[] = [domain]) {
  const explicit = text(context, rowId, field);
  if (explicit) return [...context.targets.values()].find((target) => target.id === explicit && acceptedTypes.includes(target.type)) ?? null;
  const legacy = legacyField ? text(context, rowId, legacyField) : null;
  const row = context.rows.find((item) => item.id === rowId)!;
  const target = context.targets.get(`${domain}:${legacy ?? row.legacy_key}`);
  return target && acceptedTypes.includes(target.type) ? target : null;
}
function targetExists(context: ApplicationContext, rowId: string, field: string, domain: string, legacyField?: string, acceptedTypes: string[] = [domain]) { return Boolean(targetFor(context, rowId, field, domain, legacyField, acceptedTypes)); }
function commonInspect(context: ApplicationContext, domains: ApplicationAdapter["domains"]) {
  const blockers: ReturnType<typeof issue>[] = [];
  for (const row of context.rows) {
    try { assertOpeningRowsReady([row], domains); } catch (error) { blockers.push(issue(row.id, error)); }
  }
  return blockers;
}
const stockAdapter: ApplicationAdapter = {
  domains: ["OPENING_STOCK"], kind: "OPENING_STOCK", mode: "OPENING", effects: ["Crée un mouvement OLD et un lot, sans rejouer les mouvements passés."],
  groupKey: (row) => row.id,
  async inspect(context) {
    const blockers = commonInspect(context, ["OPENING_STOCK"]);
    for (const row of context.rows) {
      try { assertOpeningStockInputs(row); } catch (error) { blockers.push(issue(row.id, error)); }
      const article = targetFor(context, row.id, "articleTargetId", "ARTICLE", "articleLegacyKey");
      if (!article) blockers.push({ row_id: row.id, field: "articleTargetId", code: "CUTOVER_STOCK_ARTICLE_UNRESOLVED", message: "Rapprocher l'article CERP avant l'ouverture du stock." });
      if (row.values.stockScope !== "OLD") blockers.push({ row_id: row.id, field: "stockScope", code: "CUTOVER_OPENING_SCOPE_INVALID", message: "Une reprise de stock doit rester dans le périmètre OLD." });
      if (row.values.owner === "CLIENT" && !targetExists(context, row.id, "ownerTargetId", "CUSTOMER", "ownerLegacyKey")) blockers.push({ row_id: row.id, field: "ownerTargetId", code: "CUTOVER_STOCK_OWNER_UNRESOLVED", message: "Rapprocher le client propriétaire avant l'ouverture du stock." });
      if (row.values.owner === "FOURNISSEUR") blockers.push({ row_id: row.id, field: "owner", code: "CUTOVER_STOCK_OWNER_UNSUPPORTED", message: "Le stock fournisseur doit passer par un flux d'achat qualifié." });
      if (row.values.valuationUnitPrice !== undefined && row.values.valuationUnitPrice !== null && String(row.values.valuationUnitPrice).trim() !== "") blockers.push({ row_id: row.id, field: "valuationUnitPrice", code: "CUTOVER_STOCK_VALUE_BASIS_REQUIRED", message: "La valeur d'ouverture nécessite sa base CUMP justifiée." });
      if (row.values.stockKind === "PF" && !targetExists(context, row.id, "customerTargetId", "CUSTOMER", "customerCode")) blockers.push({ row_id: row.id, field: "customerCode", code: "CUTOVER_STOCK_PF_CUSTOMER_REQUIRED", message: "Rapprocher le client CERP de la pièce finie." });
      if (row.values.stockKind === "PF" && article) {
        try { await resolveOpeningPfTechnicalVersionTx(context.client, row, article.id); } catch (error) { blockers.push(issue(row.id, error)); }
      }
    }
    return blockers;
  },
  async apply(context) { return applyOpeningStockTx({ client: context.client, rows: context.rows, targets: context.targets, audit: audit(context), idempotencyKeyFor: (row) => `${context.operationKey}:${row.id}` }); },
};
const wipAdapter: ApplicationAdapter = {
  domains: ["WIP"], kind: "RESUME_WIP", mode: "OPENING", effects: ["Prépare un OF brouillon pour la cohorte physique confirmée, avec son avancement et sa matière d'ouverture. Aucun ancien pointage ni mouvement de stock n'est rejoué."], groupKey: (row) => row.id,
  async inspect(context) {
    const blockers = commonInspect(context, ["WIP"]);
    for (const row of context.rows) {
      if (!targetExists(context, row.id, "articleTargetId", "ARTICLE", "articleLegacyKey")) blockers.push({ row_id: row.id, field: "articleTargetId", code: "CUTOVER_WIP_TARGET_UNRESOLVED", message: "Rapprocher l'article CERP." });
      if (!targetExists(context, row.id, "affairTargetId", "SALES_ORDER", "affairLegacyKey", ["SALES_ORDER", "INTERNAL_DEMAND", "COMMANDE_CLIENT", "BESOIN_INTERNE"]) && !targetExists(context, row.id, "affairTargetId", "INTERNAL_DEMAND", "affairLegacyKey", ["SALES_ORDER", "INTERNAL_DEMAND", "COMMANDE_CLIENT", "BESOIN_INTERNE"])) blockers.push({ row_id: row.id, field: "affairTargetId", code: "CUTOVER_WIP_TARGET_UNRESOLVED", message: "Rapprocher l'affaire CERP." });
      if (!text(context, row.id, "workshopValidator") || !text(context, row.id, "evidenceReference")) blockers.push({ row_id: row.id, field: "evidenceReference", code: "CUTOVER_WIP_EVIDENCE_REQUIRED", message: "Faire confirmer l'encours par l'atelier." });
      if (row.values.resumeMode !== "NATIVE_RESUME") {
        blockers.push({ row_id: row.id, field: "resumeMode", code: "CUTOVER_WIP_RESUMPTION_REQUIRED", message: "Cet encours reste en préparation. Compléter sa reprise native avant de charger la fabrication ; aucun OF ne sera créé à partir d'un dossier à compléter." });
        continue;
      }
      const article = targetFor(context, row.id, "articleTargetId", "ARTICLE", "articleLegacyKey");
      const types = ["SALES_ORDER", "INTERNAL_DEMAND", "COMMANDE_CLIENT", "BESOIN_INTERNE"];
      const affair = targetFor(context, row.id, "affairTargetId", "SALES_ORDER", "affairLegacyKey", types) ?? targetFor(context, row.id, "affairTargetId", "INTERNAL_DEMAND", "affairLegacyKey", types);
      if (article && affair) try { await inspectNativeWipPreparationTx(context.client, { row, article, affair, actorId: context.actorId, sourceSystem: context.sourceSystem, operationKey: context.operationKey }); } catch (error) { blockers.push(issue(row.id, error)); }
    }
    return blockers;
  },
  async apply(context) {
    if (context.rows.some((row) => row.values.resumeMode !== "NATIVE_RESUME")) throw new HttpError(409, "CUTOVER_WIP_RESUMPTION_REQUIRED", "Compléter la reprise native avant de charger ces encours.");
    return applyWipOpeningTx({ client: context.client, rows: context.rows, targets: context.targets, actorId: context.actorId, sourceSystem: context.sourceSystem, operationKey: context.operationKey });
  },
};
const financeAdapter: ApplicationAdapter = {
  domains: ["OPENING_RECEIVABLE", "OPENING_PAYABLE", "LEGACY_DELIVERY", "LEGACY_RECEIPT"], kind: "OPENING_FINANCE", mode: "OPENING", effects: ["Crée un état à rapprocher ; aucune facture, aucun règlement et aucun mouvement de stock."], groupKey: (row) => row.id,
  async inspect(context) {
    const blockers = commonInspect(context, ["OPENING_RECEIVABLE", "OPENING_PAYABLE", "LEGACY_DELIVERY", "LEGACY_RECEIPT"]);
    for (const row of context.rows) {
      const partnerDomain = row.domain === "OPENING_RECEIVABLE" || row.domain === "LEGACY_DELIVERY" ? "CUSTOMER" : "SUPPLIER";
      if (!targetExists(context, row.id, "partnerTargetId", partnerDomain, "partnerLegacyKey")) blockers.push({ row_id: row.id, field: "partnerTargetId", code: "CUTOVER_FINANCE_PARTNER_UNRESOLVED", message: "Rapprocher le partenaire CERP." });
      if ((row.domain === "LEGACY_DELIVERY" || row.domain === "LEGACY_RECEIPT") && !targetExists(context, row.id, "articleTargetId", "ARTICLE", "articleLegacyKey")) blockers.push({ row_id: row.id, field: "articleTargetId", code: "CUTOVER_UNBILLED_TARGET_UNRESOLVED", message: "Rapprocher l'article CERP." });
    }
    return blockers;
  },
  async apply(context) { return applyFinanceOpeningsTx({ client: context.client, rows: context.rows, targets: context.targets, actorId: context.actorId }); },
};

export const openingApplicationAdapters: ApplicationAdapter[] = [stockAdapter, wipAdapter, financeAdapter];
