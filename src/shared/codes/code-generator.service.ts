import type { PoolClient } from "pg";

import { HttpError } from "../../utils/httpError";

type DbQueryer = Pick<PoolClient, "query">;

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function yearFromDate(d: Date): number {
  const y = d.getUTCFullYear();
  if (!Number.isFinite(y) || y < 1970) throw new Error("Invalid date for code generation");
  return y;
}

async function nextCodeValue(tx: DbQueryer, key: string): Promise<number> {
  const res = await tx.query<{ v: string }>(
    `SELECT public.fn_next_code_value($1)::bigint::text AS v`,
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

export async function generateClientCode(tx: DbQueryer): Promise<string> {
  const n = await nextCodeValue(tx, "CLI");
  return `CLI-${pad(n, 3)}`;
}

export async function generateDevisCode(tx: DbQueryer, params: { client_id: string; date?: Date }): Promise<string> {
  const date = params.date ?? new Date();
  const y = yearFromDate(date);
  const clientCode = await requireClientCode(tx, params.client_id);
  const seq = await nextCodeValue(tx, `DEV:${y}`);
  return `DEV-${clientCode}-${y}-${pad(seq, 4)}`;
}

export async function generateCommandeCode(tx: DbQueryer, params: { client_code: string; date?: Date }): Promise<string> {
  const date = params.date ?? new Date();
  const y = yearFromDate(date);
  const seq = await nextCodeValue(tx, `CC:${y}`);
  return `CC-${params.client_code}-${y}-${pad(seq, 4)}`;
}

export async function generateAffaireCode(
  tx: DbQueryer,
  params: { type: "LIV" | "PROD"; client_code: string; date?: Date }
): Promise<string> {
  const date = params.date ?? new Date();
  const y = yearFromDate(date);
  const seq = await nextCodeValue(tx, `AFF-${params.type}:${y}`);
  return `AFF-${params.type}-${params.client_code}-${y}-${pad(seq, 4)}`;
}

export async function generatePieceTechniqueCode(
  tx: DbQueryer,
  params: { client_id: string; date?: Date }
): Promise<string> {
  const clientCode = await requireClientCode(tx, params.client_id);
  const seq = await nextCodeValue(tx, `PCT:${clientCode}`);
  return `PCT-${clientCode}-${pad(seq, 4)}`;
}

export async function generateOfCode(tx: DbQueryer, params: { date?: Date }): Promise<string> {
  const date = params.date ?? new Date();
  const y = yearFromDate(date);
  const seq = await nextCodeValue(tx, `OF:${y}`);
  return `OF-${y}-${pad(seq, 5)}`;
}

export async function generateFournisseurCode(tx: DbQueryer): Promise<string> {
  const seq = await nextCodeValue(tx, `FOU`);
  return `FOU-${pad(seq, 3)}`;
}

export async function generateArticleCode(tx: DbQueryer): Promise<string> {
  const seq = await nextCodeValue(tx, `ART`);
  return `ART-${pad(seq, 4)}`;
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
