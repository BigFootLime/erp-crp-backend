import type { PoolClient } from "pg";

import { HttpError } from "../../utils/httpError";

type DbQueryer = Pick<PoolClient, "query">;

const ASCII_SEGMENT = /[^A-Z0-9]+/g;
const ASCII_PLAN_SEPARATOR = /[^A-Z0-9]+/g;

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

/**
 * Technical plan references often contain meaningful groups separated by
 * spaces, slashes or dashes (for example `170 25464 001`). Keep those groups
 * readable in business codes while normalising every separator to one dash.
 */
function normalizePlanReference(value: string): string {
  const normalized = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(ASCII_PLAN_SEPARATOR, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new HttpError(400, "INVALID_CODE_SEGMENT", "Plan reference is required to build the business code.");
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
    normalizePlanReference(input.planReference),
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

/**
 * Canonical, immutable snapshot code for a fabricated article.
 *
 * The identity is read from the linked technical piece at the instant the
 * article is created. An applicable technical version wins; a newly-created
 * technical piece has only a draft version, so the newest non-obsolete version
 * is used as an explicit fallback. The article code is never recalculated on
 * later technical revisions.
 */
export async function generateFabricatedArticleBusinessCode(
  tx: DbQueryer,
  pieceTechniqueId: string
): Promise<string> {
  const result = await tx.query<{
    piece_exists: boolean;
    client_code: string | null;
    plan_reference: string | null;
    indice: string | null;
    version_interne: number | string | null;
  }>(
    `
      SELECT
        true AS piece_exists,
        COALESCE(NULLIF(btrim(c.client_code), ''), NULLIF(btrim(pt.code_client), '')) AS client_code,
        v.plan_reference,
        COALESCE(NULLIF(btrim(v.indice_externe_original), ''), NULLIF(btrim(v.indice), '')) AS indice,
        v.version_interne
      FROM public.pieces_techniques pt
      LEFT JOIN public.clients c ON c.client_id = pt.client_id
      LEFT JOIN LATERAL (
        SELECT
          pv.plan_reference,
          pv.indice,
          pv.indice_externe_original,
          pv.version_interne
        FROM public.piece_technique_versions pv
        WHERE pv.piece_technique_id = pt.id
          AND pv.statut <> 'OBSOLETE'
        ORDER BY
          CASE WHEN pv.statut = 'APPLICABLE' THEN 0 ELSE 1 END,
          pv.version_interne DESC NULLS LAST,
          pv.created_at DESC,
          pv.id DESC
        LIMIT 1
      ) v ON true
      WHERE pt.id = $1::uuid
        AND pt.deleted_at IS NULL
      LIMIT 1
    `,
    [pieceTechniqueId]
  );

  const source = result.rows[0];
  if (!source?.piece_exists) {
    throw new HttpError(400, "INVALID_PIECE_TECHNIQUE", "Pièce technique introuvable pour la codification de l'article fabriqué.");
  }
  if (!source.client_code?.trim()) {
    throw new HttpError(400, "CLIENT_CODE_REQUIRED", "Code client manquant sur la pièce technique : impossible de générer le code article fabriqué.");
  }
  if (!source.plan_reference?.trim()) {
    throw new HttpError(400, "PLAN_REFERENCE_REQUIRED", "Aucune version non obsolète avec référence plan n'est disponible pour cette pièce technique.");
  }
  if (!source.indice?.trim()) {
    throw new HttpError(400, "INDEX_REQUIRED", "Aucune version non obsolète avec indice n'est disponible pour cette pièce technique.");
  }

  const parts = [
    "ART",
    "FAB",
    normalizeClientSegment(source.client_code),
    normalizePlanReference(source.plan_reference),
    normalizeSegment(source.indice, "External index"),
  ];
  const version = Number(source.version_interne);
  if (Number.isInteger(version) && version > 1) parts.push(`V${version}`);

  // `articles.code` est un TEXT indexé et les références plan PT acceptent
  // volontairement jusqu'à 160 caractères. Ne pas introduire ici une limite
  // arbitraire plus courte que le contrat source.
  return parts.join("-");
}

export async function generateTransactionalBusinessCode(
  tx: DbQueryer,
  input: {
    prefix:
      | "DEV"
      | "CMD"
      | "AFF"
      | "OF"
      | "LOT"
      | "MVT"
      | "CQ"
      | "NC"
      | "CAPA"
      | "BL"
      | "FACT"
      | "BCF"
      // #228: plans de contrôle et dérogations qualité.
      | "PC"
      | "DER"
      // #229: exécutions métrologiques et dossiers d'analyse d'impact.
      | "MEX"
      | "MIA";
    date?: Date;
    width?: number;
  }
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

/** #165 — Physical machine: MCH-NNNNNN, allocated server-side in the creation transaction. */
export async function generateMachineCode(tx: DbQueryer): Promise<string> {
  const seq = await nextCodeValue(tx, "MCH");
  return `MCH-${pad(seq, 6)}`;
}

/**
 * #229 — Équipement de métrologie : MET-NNNNNN.
 *
 * Le code visible est alloué par le SERVEUR dans la transaction de création. Un
 * code proposé par l'interface n'est jamais retenu, et le code attribué est
 * ensuite immuable (trigger `fn_protect_metrologie_equipement_229`).
 */
export async function generateMetrologieEquipementCode(tx: DbQueryer): Promise<string> {
  const seq = await nextCodeValue(tx, "MET");
  return `MET-${pad(seq, 6)}`;
}

/** #229 — Exécution métrologique (étalonnage/vérification) : MEX-AAAA-NNNNNN. */
export async function generateMetrologieExecutionCode(
  tx: DbQueryer,
  params?: { date?: Date }
): Promise<string> {
  return generateTransactionalBusinessCode(tx, { prefix: "MEX", date: params?.date, width: 6 });
}

/** #229 — Dossier d'analyse d'impact métrologique : MIA-AAAA-NNNNN. */
export async function generateMetrologieImpactCode(
  tx: DbQueryer,
  params?: { date?: Date }
): Promise<string> {
  return generateTransactionalBusinessCode(tx, { prefix: "MIA", date: params?.date, width: 5 });
}

/**
 * #210 — Finition de surface : FIN-NNNNNN.
 *
 * Le code visible est alloué par le SERVEUR dans la transaction de création ;
 * un code proposé par l'interface n'est jamais retenu, et le code attribué est
 * ensuite immuable (trigger `fn_protect_surface_finish_code_210`).
 */
export async function generateSurfaceFinishCode(tx: DbQueryer): Promise<string> {
  const seq = await nextCodeValue(tx, "FIN");
  return `FIN-${pad(seq, 6)}`;
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
