import type { PoolClient } from "pg";

import { HttpError } from "../../utils/httpError";

type DbQueryer = Pick<PoolClient, "query">;

const ASCII_SEGMENT = /[^A-Z0-9]+/g;

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function yearFromDate(d: Date): number {
  const y = d.getUTCFullYear();
  if (!Number.isFinite(y) || y < 1970) throw new Error("Invalid date for code generation");
  return y;
}

function normalizeSegment(value: string, field: string): string {
  const normalized = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(ASCII_SEGMENT, "");

  if (!normalized) {
    throw new HttpError(400, "INVALID_CODE_SEGMENT", `${field} is required to build the business code.`);
  }
  return normalized;
}

function normalizeClientSegment(value: string): string {
  const normalized = normalizeSegment(value, "Client").replace(/^CLI/, "");
  if (!normalized) {
    throw new HttpError(400, "INVALID_CLIENT_CODE", "Client code is invalid for business code generation.");
  }
  return /^\d+$/.test(normalized) ? normalized.padStart(3, "0") : normalized;
}

async function nextCodeValue(tx: DbQueryer, key: string): Promise<number> {
  const res = await tx.query<{ v: string }>(
    // `nextval` is deliberately non-transactional: a number consumed by a
    // failed create is never silently re-issued on the next attempt.
    `SELECT public.fn_next_issued_code_value($1)::bigint::text AS v`,
    [key]
  );
  const raw = res.rows[0]?.v;
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) throw new Error(`Failed to allocate code sequence for key '${key}'`);
  return n;
}

export async function requireClientCode(tx: DbQueryer, clientId: string): Promise<string> {
  const res = await tx.query<{ client_code: string | null }>(
    `SELECT client_code FROM public.clients WHERE client_id = $1 LIMIT 1`,
    [clientId]
  );
  const code = (res.rows[0]?.client_code ?? "").trim();
  if (!code) {
    throw new HttpError(400, "CLIENT_CODE_REQUIRED", "Code client manquant : impossible de générer un code.");
  }
  return code;
}

export function previewPieceTechniqueCode(input: {
  clientCode: string;
  planReference: string;
  indiceExterne: string;
}): string {
  return [
    normalizeClientSegment(input.clientCode),
    normalizeSegment(input.planReference, "Plan reference"),
    normalizeSegment(input.indiceExterne, "External index"),
  ].join("-");
}

export async function generatePieceTechniqueBusinessCode(
  tx: DbQueryer,
  input: { clientId?: string | null; clientCode?: string | null; planReference: string; indiceExterne: string }
): Promise<string> {
  const clientCode = input.clientId ? await requireClientCode(tx, input.clientId) : input.clientCode;
  if (!clientCode) {
    throw new HttpError(400, "CLIENT_CODE_REQUIRED", "Client code is required to generate the technical piece code.");
  }
  return previewPieceTechniqueCode({
    clientCode,
    planReference: input.planReference,
    indiceExterne: input.indiceExterne,
  });
}

export function previewArticleCode(familyCode: string): string {
  return `ART-${normalizeSegment(familyCode, "Article family")}-000000`;
}

export async function generateArticleBusinessCode(tx: DbQueryer, familyCode: string): Promise<string> {
  const family = normalizeSegment(familyCode, "Article family");
  const seq = await nextCodeValue(tx, `ART:${family}`);
  return `ART-${family}-${pad(seq, 6)}`;
}

export async function generateTransactionalBusinessCode(
  tx: DbQueryer,
  input: { prefix: "DEV" | "CMD" | "AFF" | "OF" | "LOT" | "MVT" | "CQ" | "NC" | "CAPA" | "BL" | "FACT" | "BCF"; date?: Date; width?: number }
): Promise<string> {
  const year = yearFromDate(input.date ?? new Date());
  const width =
    input.width ??
    (input.prefix === "DEV" || input.prefix === "CMD" || input.prefix === "AFF" || input.prefix === "BCF" ? 4 : 6);
  const seq = await nextCodeValue(tx, `${input.prefix}:${year}`);
  return `${input.prefix}-${year}-${pad(seq, width)}`;
}

export async function generateClientCode(tx: DbQueryer): Promise<string> {
  const n = await nextCodeValue(tx, "CLI");
  return `CLI-${pad(n, 3)}`;
}

export async function generateDevisCode(tx: DbQueryer, params: { client_id: string; date?: Date }): Promise<string> {
  return generateTransactionalBusinessCode(tx, { prefix: "DEV", date: params.date });
}

export async function generateCommandeCode(tx: DbQueryer, params: { client_code: string; date?: Date }): Promise<string> {
  return generateTransactionalBusinessCode(tx, { prefix: "CMD", date: params.date });
}

export async function generateAffaireCode(
  tx: DbQueryer,
  params: { type: "LIV"; client_code: string; date?: Date }
): Promise<string> {
  return generateTransactionalBusinessCode(tx, { prefix: "AFF", date: params.date });
}

export async function generatePieceTechniqueCode(
  _tx: DbQueryer,
  _params: { client_id: string; date?: Date }
): Promise<string> {
  throw new HttpError(400, "TECHNICAL_CODE_CONTEXT_REQUIRED", "Use plan reference and external index to generate a technical piece code.");
}

export async function generateOfCode(tx: DbQueryer, params: { date?: Date }): Promise<string> {
  return generateTransactionalBusinessCode(tx, { prefix: "OF", date: params.date });
}

export async function generateFournisseurCode(tx: DbQueryer): Promise<string> {
  const seq = await nextCodeValue(tx, `FOU`);
  return `FOU-${pad(seq, 3)}`;
}

/** #172 — Bon de commande fournisseur : BCF-AAAA-NNNN, alloué en transaction, immuable. */
export async function generateCommandeFournisseurCode(tx: DbQueryer, params?: { date?: Date }): Promise<string> {
  return generateTransactionalBusinessCode(tx, { prefix: "BCF", date: params?.date });
}

export async function generateArticleCode(_tx: DbQueryer): Promise<string> {
  throw new HttpError(400, "ARTICLE_FAMILY_REQUIRED", "Use an article family to generate an article code.");
}

export async function generateBlCode(tx: DbQueryer): Promise<string> {
  const res = await tx.query<{ n: string }>(`SELECT nextval('public.bon_livraison_no_seq')::text AS n`);
  const raw = res.rows[0]?.n;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error("Failed to reserve bon_livraison number");
  return String(`BL-${String(n).padStart(8, "0")}`).slice(0, 30);
}

export async function generateReceptionCode(tx: DbQueryer): Promise<string> {
  const res = await tx.query<{ n: string }>(`SELECT nextval('public.reception_fournisseur_no_seq')::text AS n`);
  const raw = res.rows[0]?.n;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error("Failed to reserve reception number");
  const padded = String(n).padStart(8, "0");
  return `RF-${padded}`;
}

export async function generateNcCode(tx: DbQueryer): Promise<string> {
  const res = await tx.query<{ ref: string }>(`SELECT public.quality_generate_nc_reference()::text AS ref`);
  const ref = (res.rows[0]?.ref ?? "").trim();
  if (!ref) throw new Error("Failed to generate NC reference");
  return ref;
}

export async function generateCapCode(tx: DbQueryer): Promise<string> {
  const res = await tx.query<{ ref: string }>(`SELECT public.quality_generate_action_reference()::text AS ref`);
  const ref = (res.rows[0]?.ref ?? "").trim();
  if (!ref) throw new Error("Failed to generate CAP reference");
  return ref;
}
