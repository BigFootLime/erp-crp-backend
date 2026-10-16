import { HttpError } from "../../../utils/httpError";
import { getClientQuoteReferenceById, listClientContacts } from "../../client/services/client.service";
import { svcGetClientById, svcListClients } from "../../client/services/clients.read.service";
import { getClientContract, getClientContractCalls, getClientContracts } from "../../client/services/client-contract.service";
import { getClientForecasts } from "../../client/services/client-contract-forecast.service";
import { clientForecastQuerySchema } from "../../client/validators/client-contract-forecast.validators";
import { getPieceTechniqueSVC } from "../../pieces-techniques/services/pieces-techniques.service";
import { listVersionsSVC } from "../../pieces-techniques/services/versions.service";
import { getStockArticleSVC, listStockArticleVersionsSVC, listStockArticlesSVC, listStockEmplacementsSVC, listStockMagasinsSVC } from "../../stock/services/stock.service";
import { listArticlesQuerySchema, listEmplacementsQuerySchema, listMagasinsQuerySchema } from "../../stock/validators/stock.validators";
import type { StockArticleListItem } from "../../stock/types/stock.types";

const REFERENCE_LIMIT = 100;
const CLIENT_REFERENCE_LIMIT = 2000;

function query(value: unknown, max = REFERENCE_LIMIT): { q: string; limit: number } {
  const q = typeof value === "object" && value !== null && typeof (value as { q?: unknown }).q === "string"
    ? (value as { q: string }).q.trim()
    : "";
  const rawLimit = typeof value === "object" && value !== null ? (value as { limit?: unknown }).limit : undefined;
  const parsed = typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : Number(rawLimit);
  return { q, limit: Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : 25 };
}

function page(value: unknown): number {
  const raw = typeof value === "object" && value !== null ? (value as { page?: unknown }).page : undefined;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), REFERENCE_LIMIT) : 1;
}

function commandArticleReference(article: StockArticleListItem) {
  return {
    id: article.id, code: article.code, designation: article.designation, family_code: article.family_code,
    piece_technique_id: article.piece_technique_id, piece_code: article.piece_code,
    piece_designation: article.piece_designation, unite: article.unite,
    qty_available: article.qty_available, qty_total: article.qty_total, qty_reserved: article.qty_reserved,
    sale_price_reference: article.sale_price_reference, sale_price_currency: article.sale_price_currency,
    sale_price_source: article.sale_price_source, quote_price_suggestion: article.quote_price_suggestion,
    applicable_version: article.applicable_version, piece_plan_reference: article.piece_plan_reference,
    piece_indice: article.piece_indice, commande_client_eligible: article.commande_client_eligible,
    commande_client_ineligibility_code: article.commande_client_ineligibility_code,
  };
}

/** Read-only customer identity needed to create a customer order. */
export async function listCommandeClientReferences(value: unknown) {
  const { q, limit } = query(value);
  const rows = await svcListClients(q, limit);
  return rows.map((row) => ({ client_id: row.client_id, client_code: row.client_code, company_name: row.company_name, status: row.status, blocked: Boolean(row.blocked) }));
}

export async function getCommandeClientReference(clientId: string) {
  const client = await getClientQuoteReferenceById(clientId);
  if (!client) throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");
  const detail = await svcGetClientById(clientId, { includeSensitiveFinance: false });
  if (!detail) throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");
  return { client, biller: detail.biller ? { id: detail.biller.id, name: detail.biller.name } : null,
    bill_address: detail.bill_address, delivery_address: detail.delivery_address };
}

export async function listCommandeClientContacts(clientId: string) {
  const rows = await listClientContacts(clientId, { includePersonalPhone: false });
  return rows.map(({ contact_id, first_name, last_name, email, phone_direct, role, civility, label }) => ({ contact_id, first_name, last_name, email, phone_direct, role, civility, label }));
}

/** Contract headers are sufficient to select a cadre source; contract mutations stay in Clients. */
export async function listCommandeClientContracts(clientId: string, value: unknown) {
  const result = await getClientContracts(clientId, page(value));
  return { items: result.items.map(({ id, client_id, reference, title, status, valid_from, valid_until, version, updated_at, line_count }) => ({ id, client_id, reference, title, status, valid_from, valid_until, version, updated_at, line_count })), total: result.total, page: result.page, page_size: result.page_size };
}

function contractLine(line: { id: string; article_id: string; root_article_id: string; replenishment_qty: string; unit_id: string; unit: string; configured_code: string; configured_designation: string; configured_indice: string; configured_piece_technique_version_id: string; proposed_article: unknown }) {
  return { id: line.id, article_id: line.article_id, root_article_id: line.root_article_id, replenishment_qty: line.replenishment_qty, unit_id: line.unit_id, unit: line.unit, configured_code: line.configured_code, configured_designation: line.configured_designation, configured_indice: line.configured_indice, configured_piece_technique_version_id: line.configured_piece_technique_version_id, proposed_article: line.proposed_article };
}
export async function getCommandeClientContract(clientId: string, contractId: string, value: unknown) {
  const result = await getClientContract(clientId, contractId, page(value));
  const { contract } = result;
  return { contract: { id: contract.id, client_id: contract.client_id, reference: contract.reference, title: contract.title, status: contract.status, valid_from: contract.valid_from, valid_until: contract.valid_until, version: contract.version, updated_at: contract.updated_at, lines: contract.lines.map(contractLine) }, client_active: result.client_active };
}
export async function listCommandeClientContractCalls(clientId: string, contractId: string, value: unknown) {
  const result = await getClientContractCalls(clientId, contractId, page(value));
  return { items: result.items.map((call: any) => ({ id: call.id, commande_id: call.commande_id, numero: call.numero, customer_reference: call.customer_reference, current_customer_reference: call.current_customer_reference, order_date: call.order_date, created_at: call.created_at, contract_version: call.contract_version, lines: call.lines })), total: result.total, page: result.page, page_size: result.page_size };
}
function forecastProjection(forecast: any) {
  return { id: forecast.id, contract_id: forecast.contract_id, contract_line_id: forecast.contract_line_id, root_article_id: forecast.root_article_id, unit_id: forecast.unit_id, article_snapshot: forecast.article_snapshot, month: forecast.month, quantity: forecast.quantity, converted_quantity: forecast.converted_quantity, remaining_quantity: forecast.remaining_quantity, delivery_due: forecast.delivery_due, estimate_date: forecast.estimate_date, status: forecast.status, version: forecast.version };
}
export async function listCommandeClientContractForecasts(clientId: string, contractId: string, value: unknown) {
  const result = await getClientForecasts(clientId, contractId, clientForecastQuerySchema.parse(value));
  if (!("items" in result)) throw new HttpError(404, "CLIENT_FORECAST_NOT_FOUND", "Estimation introuvable.");
  return { items: result.items.map(forecastProjection), total: result.total, page: result.page, page_size: result.page_size };
}
export async function getCommandeClientContractForecast(clientId: string, contractId: string, forecastId: string, value: unknown) {
  const result = await getClientForecasts(clientId, contractId, clientForecastQuerySchema.parse(value), forecastId);
  if (!("forecast" in result)) throw new HttpError(404, "CLIENT_FORECAST_NOT_FOUND", "Estimation introuvable.");
  return { forecast: forecastProjection(result.forecast) };
}

/** Minimal technical composition used only by the Commandes reconciliation panel. */
export async function getCommandeReferencePiece(pieceId: string) {
  const piece = await getPieceTechniqueSVC(pieceId, new Set(["nomenclature", "achats"]));
  if (!piece) throw new HttpError(404, "PIECE_TECHNIQUE_NOT_FOUND", "Pièce technique introuvable.");
  return { id: piece.id, code_piece: piece.code_piece, designation: piece.designation, designation_2: piece.designation_2,
    bom: piece.bom.map(({ id, child_piece_id, designation, quantite }) => ({ id: id ?? null, child_piece_id, designation: designation ?? null, quantite })),
    achats: piece.achats.map(({ id, nom, designation, article_id, quantite }) => ({ id: id ?? null, nom: nom ?? null, designation: designation ?? null, article_id: article_id ?? null, quantite })),
  };
}

/** Canonical piece versions used to reconcile the selected article version. */
export async function listCommandeReferencePieceVersions(pieceId: string) {
  const rows = await listVersionsSVC(pieceId);
  return rows.map(({ id, piece_technique_id, indice, statut, is_current, plan_reference, date_application, manufacturing_mode, assembly_supply_strategy }) => ({
    id, piece_technique_id, indice, statut, is_current, plan_reference, date_application, manufacturing_mode, assembly_supply_strategy,
  }));
}

/** Technical choices for an article, without opening Stock or Technical-data workspaces. */
export async function listCommandeReferenceArticleVersions(articleId: string, value: unknown) {
  const result = await listStockArticleVersionsSVC(articleId, { page: page(value), pageSize: REFERENCE_LIMIT });
  if (!result) throw new HttpError(404, "ARTICLE_NOT_FOUND", "Article introuvable.");
  return { items: result.items.map(({ id, indice, statut, plan_reference, date_application, manufacturing_mode, assembly_supply_strategy }) => ({ id, indice, statut, plan_reference, date_application, manufacturing_mode, assembly_supply_strategy })), total: result.total };
}

/** Product choices and their server-side commercial eligibility for Commandes only. */
export async function listCommandeReferenceArticles(value: unknown) {
  const filters = listArticlesQuerySchema.parse(value);
  const result = await listStockArticlesSVC({ ...filters, pageSize: Math.min(filters.pageSize, REFERENCE_LIMIT) });
  return { items: result.items.map(commandArticleReference), total: result.total };
}

export async function getCommandeReferenceArticle(articleId: string) {
  const article = await getStockArticleSVC(articleId);
  if (!article) throw new HttpError(404, "ARTICLE_NOT_FOUND", "Article introuvable.");
  return commandArticleReference(article);
}

/** Internal orders can choose a destination without opening the Stock workspace. */
export async function listCommandeReferenceMagasins(value: unknown) {
  const filters = listMagasinsQuerySchema.parse(value);
  const result = await listStockMagasinsSVC({ ...filters, pageSize: Math.min(filters.pageSize, REFERENCE_LIMIT) });
  return { items: result.items.map(({ id, code, name, is_active }) => ({ id, code, name, is_active })), total: result.total };
}

export async function listCommandeReferenceEmplacements(value: unknown) {
  const filters = listEmplacementsQuerySchema.parse(value);
  const result = await listStockEmplacementsSVC({ ...filters, pageSize: Math.min(filters.pageSize, REFERENCE_LIMIT) });
  return { items: result.items.map(({ id, magasin_id, code, name, is_scrap, is_active, location_type, allow_inbound, allow_outbound }) => ({ id, magasin_id, code, name, is_scrap, is_active, location_type, allow_inbound, allow_outbound })), total: result.total };
}
