import { HttpError } from "../../../utils/httpError";
import { getClientQuoteReferenceById, listClientContacts } from "../../client/services/client.service";
import { svcListClients } from "../../client/services/clients.read.service";
import { getClientContracts } from "../../client/services/client-contract.service";
import { getPieceTechniqueSVC } from "../../pieces-techniques/services/pieces-techniques.service";
import { listStockArticleVersionsSVC } from "../../stock/services/stock.service";

const REFERENCE_LIMIT = 100;

function query(value: unknown): { q: string; limit: number } {
  const q = typeof value === "object" && value !== null && typeof (value as { q?: unknown }).q === "string"
    ? (value as { q: string }).q.trim()
    : "";
  const rawLimit = typeof value === "object" && value !== null ? (value as { limit?: unknown }).limit : undefined;
  const parsed = typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : Number(rawLimit);
  return { q, limit: Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), REFERENCE_LIMIT) : 25 };
}

function page(value: unknown): number {
  const raw = typeof value === "object" && value !== null ? (value as { page?: unknown }).page : undefined;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), REFERENCE_LIMIT) : 1;
}

/** Read-only customer identity needed to create a customer order. */
export async function listCommandeClientReferences(value: unknown) {
  const { q, limit } = query(value);
  const rows = await svcListClients(q, limit);
  return rows.map((row) => ({
    client_id: row.client_id,
    client_code: row.client_code,
    company_name: row.company_name,
    status: row.status,
    blocked: Boolean(row.blocked),
  }));
}

export async function getCommandeClientReference(clientId: string) {
  const client = await getClientQuoteReferenceById(clientId);
  if (!client) throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");
  return client;
}

export async function listCommandeClientContacts(clientId: string) {
  const rows = await listClientContacts(clientId, { includePersonalPhone: false });
  return rows.map(({ contact_id, first_name, last_name, email, phone_direct, role, civility, label }) => ({
    contact_id,
    first_name,
    last_name,
    email,
    phone_direct,
    role,
    civility,
    label,
  }));
}

/** Contract headers are sufficient to select a cadre source; contract mutations stay in Clients. */
export async function listCommandeClientContracts(clientId: string, value: unknown) {
  const result = await getClientContracts(clientId, page(value));
  return {
    items: result.items.map(({ id, client_id, reference, title, status, valid_from, valid_until, version, updated_at, line_count }) => ({
      id, client_id, reference, title, status, valid_from, valid_until, version, updated_at, line_count,
    })),
    total: result.total,
    page: result.page,
    page_size: result.page_size,
  };
}

/** Minimal technical composition used only by the Commandes reconciliation panel. */
export async function getCommandeReferencePiece(pieceId: string) {
  const piece = await getPieceTechniqueSVC(pieceId, new Set(["nomenclature", "achats"]));
  if (!piece) throw new HttpError(404, "PIECE_TECHNIQUE_NOT_FOUND", "Pièce technique introuvable.");
  return {
    id: piece.id,
    code_piece: piece.code_piece,
    designation: piece.designation,
    designation_2: piece.designation_2,
    bom: piece.bom.map(({ id, child_piece_id, designation, quantite }) => ({ id: id ?? null, child_piece_id, designation: designation ?? null, quantite })),
    achats: piece.achats.map(({ id, nom, designation, article_id, quantite }) => ({ id: id ?? null, nom: nom ?? null, designation: designation ?? null, article_id: article_id ?? null, quantite })),
  };
}

/** Technical choices for an article, without opening Stock or Technical-data workspaces. */
export async function listCommandeReferenceArticleVersions(articleId: string, value: unknown) {
  const result = await listStockArticleVersionsSVC(articleId, { page: page(value), pageSize: REFERENCE_LIMIT });
  if (!result) throw new HttpError(404, "ARTICLE_NOT_FOUND", "Article introuvable.");
  return {
    items: result.items.map(({ id, indice, statut, plan_reference, date_application, manufacturing_mode, assembly_supply_strategy }) => ({
      id, indice, statut, plan_reference, date_application, manufacturing_mode: manufacturing_mode ?? null,
      assembly_supply_strategy: assembly_supply_strategy ?? null,
    })),
    total: result.total,
  };
}