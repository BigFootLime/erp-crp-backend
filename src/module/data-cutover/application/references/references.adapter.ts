import { HttpError } from "../../../../utils/httpError";
import { repoCreateClientCutoverTx } from "../../../client/repository/client.repository";
import { createClientSchema } from "../../../client/validators/client.validators";
import { repoCreateFournisseurCutoverTx } from "../../../fournisseurs/repository/fournisseurs.repository";
import { createFournisseurSchema } from "../../../fournisseurs/validators/fournisseurs.validators";
import { repoCreatePieceTechniqueCutoverTx } from "../../../pieces-techniques/repository/pieces-techniques.repository";
import { createPieceTechniqueSchema } from "../../../pieces-techniques/validators/pieces-techniques.validators";
import { repoCreateArticleTx } from "../../../stock/repository/stock.repository";
import { createArticleSchema } from "../../../stock/validators/stock.validators";
import type { ApplicationAdapter, ApplicationContext, AppliedApplicationTarget } from "../application.types";
import type { CutoverRow } from "../../types/data-cutover.types";
import { applicationInputIssues } from "../application.errors";

const audit = (user_id: number) => ({ user_id, role: "SuperAdmin", ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null });
const text = (row: CutoverRow, key: string, label: string): string => {
  const value = row.values[key];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(422, "CUTOVER_REFERENCE_REQUIRED", `${label} doit etre renseigne.`);
  return value.trim();
};
const optional = (row: CutoverRow, key: string): string | null => {
  const value = row.values[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};
const bool = (row: CutoverRow, key: string) => {
  if (typeof row.values[key] !== "boolean") throw new HttpError(422, "CUTOVER_REFERENCE_BOOLEAN_REQUIRED", `${key} doit etre confirme explicitement.`);
  return row.values[key];
};
const nativeKey: Record<string, string> = { CUSTOMER: "customerCode", SUPPLIER: "supplierCode", ARTICLE: "articleReference", TECHNICAL_PIECE: "articleReference" };
const target = (context: ApplicationContext, type: string, row: CutoverRow, directField = "targetId", legacyField = nativeKey[type] ?? "") => {
  const explicit = optional(row, directField);
  if (explicit) {
    for (const resolved of context.targets.values()) if (resolved.type === type && resolved.id === explicit) return resolved;
    return null;
  }
  const legacy = optional(row, legacyField);
  return legacy ? context.targets.get(`${type}:${legacy}`) ?? null : null;
};
const linkOrCreate = (row: CutoverRow) => text(row, "resolution", "Le choix de rapprochement") as "LINK" | "CREATE";

function clientBody(row: CutoverRow) {
  const country = text(row, "country", "Le pays de facturation");
  const bill = { name: text(row, "name", "La raison sociale"), street: text(row, "address", "L'adresse de facturation"), postal_code: text(row, "postalCode", "Le code postal"), city: text(row, "city", "La ville"), country };
  const same = bool(row, "deliverySameAsBilling");
  const delivery = same ? bill : { name: text(row, "name", "La raison sociale"), street: text(row, "deliveryAddress", "L'adresse de livraison"), postal_code: text(row, "deliveryPostalCode", "Le code postal de livraison"), city: text(row, "deliveryCity", "La ville de livraison"), country: text(row, "deliveryCountry", "Le pays de livraison") };
  return createClientSchema.parse({ company_name: bill.name, email: optional(row, "email") ?? undefined, siret: optional(row, "siret") ?? undefined, vat_number: optional(row, "vatNumber") ?? undefined, status: "client", blocked: false, creation_date: text(row, "creationDate", "La date source de creation"), payment_mode_ids: [], bill_address: bill, delivery_address: delivery, contacts: [] });
}
function supplierBody(row: CutoverRow) {
  return createFournisseurSchema.parse({ body: { nom: text(row, "name", "La raison sociale"), email: optional(row, "email") ?? undefined, siret: optional(row, "siret") ?? undefined, tva: optional(row, "vatNumber") ?? undefined, actif: true } }).body;
}
function technicalBody(context: ApplicationContext, row: CutoverRow) {
  const customer = target(context, "CUSTOMER", row, "customerTargetId", "customerCode");
  if (!customer) throw new HttpError(422, "CUTOVER_TECHNICAL_CUSTOMER_UNRESOLVED", "Le client CERP doit etre confirme avant la piece technique.");
  const article = target(context, "ARTICLE", row, "articleTargetId", "articleReference");
  return createPieceTechniqueSchema.parse({ body: { article_id: article?.id ?? null, client_id: customer.id, code_client: customer.reference ?? undefined, name_piece: text(row, "designation", "La designation"), designation: text(row, "designation", "La designation"), plan_reference: text(row, "planReference", "La reference du plan"), indice_externe: bool(row, "withoutRevision") ? undefined : text(row, "externalRevision", "L'indice externe"), sans_indice: bool(row, "withoutRevision"), statut: "DRAFT", bom: [], operations: [], achats: [] } }).body;
}
function articleBody(context: ApplicationContext, row: CutoverRow) {
  const category = text(row, "category", "La categorie");
  if (category === "matiere") throw new HttpError(422, "CUTOVER_ARTICLE_MATERIAL_INCOMPLETE", "Une matiere exige sa nuance et ses dimensions natives; elle ne peut pas etre deduite de cette fiche.");
  const technical = target(context, "TECHNICAL_PIECE", row, "technicalPieceId", "technicalPieceLegacyKey");
  if (category === "fabrique" && !technical) throw new HttpError(422, "CUTOVER_ARTICLE_TECHNICAL_UNRESOLVED", "Une piece technique CERP confirmee est requise pour un article fabrique.");
  const commercialScope = optional(row, "commercialScope");
  const commercialCustomer = commercialScope === "CLIENTS"
    ? target(context, "CUSTOMER", row, "commercialClientTargetId", "commercialCustomerCode")
    : null;
  if (category === "fabrique" && commercialScope !== "CLIENTS" && commercialScope !== "CRP") {
    throw new HttpError(422, "CUTOVER_ARTICLE_COMMERCIAL_SCOPE_REQUIRED", "Choisir si l'article fabrique est destine a un client ou a CRP.");
  }
  if (commercialScope === "CLIENTS" && !commercialCustomer) {
    throw new HttpError(422, "CUTOVER_ARTICLE_COMMERCIAL_CUSTOMER_UNRESOLVED", "Le client CERP de l'article fabrique doit etre rapproche explicitement.");
  }
  const businessCategory = category === "fabrique"
    ? "piece_finie_fabriquee"
    : category === "matiere"
      ? "matiere_premiere"
      : category === "traitement"
        ? "traitement_surface"
        : "achat";
  return createArticleSchema.parse({ body: { designation: text(row, "designation", "La designation"), article_category: category, article_categories: [businessCategory], article_type: category === "fabrique" ? "PIECE_TECHNIQUE" : "PURCHASED", family_code: text(row, "familyCode", "La famille CERP"), internal_reference: text(row, "articleReference", "La reference historique"), unite: text(row, "unit", "L'unite"), piece_technique_id: technical?.id ?? null, stock_managed: true, lot_tracking: bool(row, "lotTracked"), is_sold: category === "fabrique", is_active: true, status: "VALIDE", commercial_scope: commercialScope === "CLIENTS" || commercialScope === "CRP" ? commercialScope : undefined, client_ids: commercialScope === "CLIENTS" ? [commercialCustomer!.id] : undefined } }).body;
}
async function assertArticleFamilyTx(context: ApplicationContext, row: CutoverRow) {
  const category = text(row, "category", "La categorie");
  const family = text(row, "familyCode", "La famille CERP");
  const queries: Record<string, string> = {
    fabrique: "SELECT 1 FROM public.articles_fabrique_families WHERE code=$1 AND is_active",
    achat: "SELECT 1 FROM public.articles_achat_families WHERE code=$1 AND is_active",
    traitement: "SELECT 1 FROM public.articles_traitement_families WHERE code=$1 AND is_active",
  };
  const query = queries[category];
  if (!query || !(await context.client.query(query, [family])).rows.length) throw new HttpError(422, "CUTOVER_ARTICLE_FAMILY_UNCONFIRMED", "Sélectionner une famille CERP active de cette catégorie. Une reprise ne crée pas implicitement une nouvelle famille depuis un ancien code.");
}

/** Native reference creation/link adapter. CREATE calls only native transaction
 * primitives; incomplete CREATE rows block preview instead of guessed fields. */
export const cutoverReferencesAdapter: ApplicationAdapter = {
  domains: ["CUSTOMER", "SUPPLIER", "ARTICLE", "TECHNICAL_PIECE"], kind: "REFERENCE", mode: "CREATE", effects: [],
  groupKey: (row) => `${row.domain}:${row.id}`,
  async inspect(context) {
    const issues: Array<{ row_id: string; field: string | null; code: string; message: string }> = [];
    for (const row of context.rows) try {
      const resolution = linkOrCreate(row);
      if (resolution === "LINK") { if (!target(context, row.domain, row)) throw new HttpError(422, "CUTOVER_REFERENCE_LINK_REQUIRED", "La fiche CERP cible doit etre selectionnee."); continue; }
      if (resolution !== "CREATE") throw new HttpError(422, "CUTOVER_REFERENCE_RESOLUTION_INVALID", "Choisir LINK ou CREATE.");
      if (row.domain === "CUSTOMER") clientBody(row);
      else if (row.domain === "SUPPLIER") supplierBody(row);
      else if (row.domain === "ARTICLE") { articleBody(context, row); await assertArticleFamilyTx(context, row); }
      else technicalBody(context, row);
    } catch (error) { issues.push(...applicationInputIssues(error, row.id).map((issue) => ({ ...issue, row_id: row.id }))); }
    return issues;
  },
  async apply(context) {
    const issues = await this.inspect(context); if (issues.length) throw new HttpError(422, issues[0]!.code, issues[0]!.message);
    const targets: AppliedApplicationTarget[] = [];
    for (const row of context.rows) {
      const resolution = linkOrCreate(row);
      if (resolution === "LINK") { const resolved = target(context, row.domain, row)!; targets.push({ rowId: row.id, domain: row.domain, targetType: row.domain, targetId: resolved.id, targetReference: resolved.reference }); continue; }
      // Client native idempotency is a UUID column. The row identifier is a
      // durable UUID and also works for the text keys used by supplier/PT
      // creators; a hashed operation key plus ':' is not a valid UUID.
      const key = row.id;
      if (row.domain === "CUSTOMER") { const created = await repoCreateClientCutoverTx(context.client, clientBody(row), audit(context.actorId), key); targets.push({ rowId: row.id, domain: row.domain, targetType: "CUSTOMER", targetId: created.client_id, targetReference: created.client_code }); }
      else if (row.domain === "SUPPLIER") { const created = await repoCreateFournisseurCutoverTx(context.client, supplierBody(row), audit(context.actorId), key); targets.push({ rowId: row.id, domain: row.domain, targetType: "SUPPLIER", targetId: created.id, targetReference: created.code }); }
      else if (row.domain === "ARTICLE") { const created = await repoCreateArticleTx(context.client, articleBody(context, row), audit(context.actorId)); targets.push({ rowId: row.id, domain: row.domain, targetType: "ARTICLE", targetId: created.id, targetReference: created.code }); }
      else { const created = await repoCreatePieceTechniqueCutoverTx(context.client, { ...technicalBody(context, row), statut: "DRAFT", en_fabrication: false, operations: [], achats: [] }, audit(context.actorId), key); targets.push({ rowId: row.id, domain: row.domain, targetType: "TECHNICAL_PIECE", targetId: created.piece.id, targetReference: created.piece.code_piece }); }
    }
    return { targets };
  },
};


/** Registry-ready domain adapters. Kept separate so the application preview can
 * publish a correctly typed planned target for each CREATE row. */
const referenceAdapterFor = (domain: "CUSTOMER" | "SUPPLIER" | "ARTICLE" | "TECHNICAL_PIECE"): ApplicationAdapter => ({
  ...cutoverReferencesAdapter,
  domains: [domain],
  plannedTargetType: domain,
});
export const cutoverReferenceAdapters: ApplicationAdapter[] = [
  referenceAdapterFor("CUSTOMER"),
  referenceAdapterFor("SUPPLIER"),
  referenceAdapterFor("TECHNICAL_PIECE"),
  referenceAdapterFor("ARTICLE"),
];
