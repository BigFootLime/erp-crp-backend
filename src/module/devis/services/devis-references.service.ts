import { HttpError } from "../../../utils/httpError";
import { svcListBillers } from "../../biller/services/billers.service";
import { getClientQuoteReferenceById, listClientContacts } from "../../client/services/client.service";
import {
  svcGetClientById,
  svcListClientAddresses,
  svcListClients,
} from "../../client/services/clients.read.service";
import { svcListPaymentModes } from "../../payment-mode/services/payment-modes.service";
import { listPieceTechniquesSVC } from "../../pieces-techniques/services/pieces-techniques.service";

const REFERENCE_LIMIT = 100;

function referenceQuery(value: unknown): { q: string; limit: number } {
  const q = typeof value === "object" && value !== null && typeof (value as { q?: unknown }).q === "string"
    ? (value as { q: string }).q.trim()
    : "";
  const rawLimit = typeof value === "object" && value !== null ? (value as { limit?: unknown }).limit : undefined;
  const parsedLimit = typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : Number(rawLimit);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), REFERENCE_LIMIT) : 25;
  return { q, limit };
}

/**
 * Read-only projections used while composing a quote. They deliberately expose only
 * values required by the quote form: granting `devis` never grants the generic
 * Clients or Pièces techniques modules, nor their create/update actions.
 */
export async function listDevisClientReferences(query: unknown) {
  const { q, limit } = referenceQuery(query);
  const rows = await svcListClients(q, limit);
  return rows.map((row) => ({
    client_id: row.client_id,
    client_code: row.client_code,
    company_name: row.company_name,
    status: row.status,
    blocked: Boolean(row.blocked),
  }));
}

export async function getDevisClientReference(clientId: string) {
  const client = await getClientQuoteReferenceById(clientId);
  if (!client) throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");

  const detail = await svcGetClientById(clientId, { includeSensitiveFinance: false });
  if (!detail) throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");

  return {
    client,
    biller: detail.biller ? { biller_id: detail.biller.id, biller_name: detail.biller.name } : null,
    bill_address: detail.bill_address,
    delivery_address: detail.delivery_address,
    payment_modes: detail.payment_modes.map((mode) => ({ value: mode.id, label: mode.type })),
  };
}
export async function listDevisClientContacts(clientId: string) {
  const contacts = await listClientContacts(clientId, { includePersonalPhone: false });
  return contacts.map(({ contact_id, first_name, last_name, email, phone_direct, role, civility, label }) => ({
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

export const listDevisClientAddresses = svcListClientAddresses;

export async function listDevisPieceTechniqueReferences(query: unknown) {
  const { q, limit } = referenceQuery(query);
  const result = await listPieceTechniquesSVC({ q, page: 1, pageSize: limit, sortBy: "designation", sortDir: "asc" });
  return result.items.map((piece) => ({
    id: piece.id,
    code_piece: piece.code_piece,
    designation: piece.designation,
    designation_2: piece.designation_2,
    client_id: piece.client_id,
    client_name: piece.client_name,
    prix_unitaire: piece.prix_unitaire,
    article_id: piece.article_id,
    version_id: null,
  }));
}

export async function listDevisBillerReferences(query: unknown) {
  const { q } = referenceQuery(query);
  const billers = await svcListBillers(q);
  return billers.map((biller) => ({ biller_id: biller.id, biller_name: biller.label }));
}

export async function listDevisPaymentModeReferences(query: unknown) {
  const { q } = referenceQuery(query);
  const modes = await svcListPaymentModes(q);
  return modes.map((mode) => ({ value: mode.value, label: mode.label }));
}
