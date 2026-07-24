import type { PoolClient } from "pg";
import crypto from "node:crypto";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { generateCommandeFournisseurCode } from "../../../shared/codes/code-generator.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import {
  allowedTargetsFrom,
  classifyTransition,
  isAllowedTransition,
  isReceptionDerivedStatut,
  transitionRequiresMotif,
  type CommandeFournisseurStatut,
} from "../domain/commande-fournisseur-transitions";
import {
  capabilityForTransition,
  roleHasCommandeFournisseurCapability,
} from "../domain/commande-fournisseur-rbac";
import { computeCommandeTotaux, computeLigneTotaux, roundMoney } from "../domain/commande-fournisseur-totaux";
import type {
  AccuseBodyDTO,
  AddLigneBodyDTO,
  CreateCommandeBodyDTO,
  PropositionsConfirmBodyDTO,
  PropositionsPreviewBodyDTO,
  ReorderLignesBodyDTO,
  TransitionBodyDTO,
  UpdateCommandeBodyDTO,
  UpdateLigneBodyDTO,
} from "../validators/commande-fournisseur.validators";
import type {
  CommandeFournisseur,
  CommandeFournisseurDocumentMeta,
  CommandeFournisseurKpis,
  CommandeFournisseurLigne,
  CommandeFournisseurListItem,
  CommandeFournisseurReceptionLiee,
  FournisseurMini,
  Paginated,
  PropositionGroupe,
  PropositionLigne,
  PropositionsPreview,
} from "../types/commande-fournisseur.types";

export type AuditContext = {
  user_id: number;
  role?: string | null;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

type DbQueryer = Pick<PoolClient, "query">;

/* ------------------------------- shared helpers ------------------------------ */

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function numOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = num(value);
  return Number.isFinite(n) ? n : null;
}

/** Sérialisation JSON stable (clés triées récursivement) pour une empreinte reproductible. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(payload: string): string {
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

async function insertAuditLog(
  tx: DbQueryer,
  audit: AuditContext,
  entry: {
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    details?: Record<string, unknown> | null;
  }
) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

async function insertTransitionRow(
  tx: DbQueryer,
  commandeId: string,
  from: CommandeFournisseurStatut | null,
  to: CommandeFournisseurStatut,
  motif: string | null,
  acteurId: number | null
) {
  await tx.query(
    `INSERT INTO public.commande_fournisseur_transition (commande_id, from_statut, to_statut, motif, acteur_id)
     VALUES ($1::uuid, $2, $3, $4, $5)`,
    [commandeId, from, to, motif, acteurId]
  );
}

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

/** Jeton de concurrence optimiste : représentation ::text exacte (pattern affaire #169). */
function assertOptimisticToken(expected: string | undefined, current: string | null) {
  if (expected && current && expected !== current) {
    throw new HttpError(
      409,
      "CONCURRENT_MODIFICATION",
      "La commande a été modifiée entre-temps. Rechargez la fiche avant de réessayer."
    );
  }
}

type HeaderLockRow = {
  id: string;
  code: string;
  statut: CommandeFournisseurStatut;
  fournisseur_id: string;
  devise: string;
  version_document: number;
  frais_port_ht: string;
  tva_frais_pct: string;
  updated_at_token: string;
};

async function lockHeader(tx: DbQueryer, id: string): Promise<HeaderLockRow> {
  const res = await tx.query<HeaderLockRow>(
    `SELECT id, code, statut, fournisseur_id, devise, version_document,
            frais_port_ht::text, tva_frais_pct::text, updated_at::text AS updated_at_token
       FROM public.commande_fournisseur
      WHERE id = $1::uuid
      FOR UPDATE`,
    [id]
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(404, "COMMANDE_FOURNISSEUR_NOT_FOUND", "Commande fournisseur introuvable.");
  return row;
}

/** Recalcule et persiste les totaux serveur à partir des lignes ACTIVE (source unique). */
async function recomputeTotauxTx(tx: DbQueryer, commandeId: string): Promise<void> {
  const lignes = await tx.query<{
    quantite: string;
    prix_unitaire_ht: string;
    remise_pct: string;
    tva_pct: string;
    frais_ht: string;
    statut_ligne: "ACTIVE" | "ANNULEE";
  }>(
    `SELECT quantite::text, prix_unitaire_ht::text, remise_pct::text, tva_pct::text, frais_ht::text, statut_ligne
       FROM public.commande_fournisseur_ligne WHERE commande_id = $1::uuid`,
    [commandeId]
  );
  const header = await tx.query<{ frais_port_ht: string; tva_frais_pct: string }>(
    `SELECT frais_port_ht::text, tva_frais_pct::text FROM public.commande_fournisseur WHERE id = $1::uuid`,
    [commandeId]
  );
  const h = header.rows[0];
  const totaux = computeCommandeTotaux(
    lignes.rows.map((l) => ({
      quantite: num(l.quantite),
      prix_unitaire_ht: num(l.prix_unitaire_ht),
      remise_pct: num(l.remise_pct),
      tva_pct: num(l.tva_pct),
      frais_ht: num(l.frais_ht),
      statut_ligne: l.statut_ligne,
    })),
    { frais_port_ht: num(h?.frais_port_ht), tva_frais_pct: num(h?.tva_frais_pct) }
  );
  await tx.query(
    `UPDATE public.commande_fournisseur
        SET total_ht = $2, total_remise = $3, total_tva = $4, total_ttc = $5
      WHERE id = $1::uuid`,
    [commandeId, totaux.total_ht, totaux.total_remise, totaux.total_tva, totaux.total_ttc]
  );
}

/* --------------------------------- fournisseur -------------------------------- */

type FournisseurRow = {
  id: string;
  code: string | null;
  nom: string | null;
  status: string | null;
  actif: boolean | null;
};

async function fetchFournisseurMini(tx: DbQueryer, fournisseurId: string): Promise<FournisseurMini> {
  const res = await tx.query<FournisseurRow>(
    `SELECT id, COALESCE(code, code_fournisseur) AS code, COALESCE(nom, raison_sociale) AS nom, status, actif
       FROM public.fournisseurs WHERE id = $1::uuid`,
    [fournisseurId]
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(422, "FOURNISSEUR_INTROUVABLE", "Le fournisseur sélectionné n'existe pas.");
  return { id: row.id, code: row.code, nom: row.nom, status: row.status, actif: row.actif };
}

function assertFournisseurCommandable(f: FournisseurMini) {
  const inactive = f.actif === false || f.status === "archive" || f.status === "inactif";
  if (inactive) {
    throw new HttpError(
      422,
      "FOURNISSEUR_INACTIF",
      "Ce fournisseur est inactif ou archivé : aucune commande ne peut lui être adressée."
    );
  }
}

/* ------------------------------------ list ----------------------------------- */

export type ListCommandesParams = {
  q?: string;
  statut?: CommandeFournisseurStatut | CommandeFournisseurStatut[];
  fournisseur_id?: string;
  origine?: string;
  en_retard?: "true" | "false";
  date_from?: string;
  date_to?: string;
  page: number;
  page_size: number;
  sort: "created_at" | "date_besoin" | "date_promesse" | "code" | "total_ttc" | "updated_at";
  dir: "asc" | "desc";
};

const SORT_COLUMNS: Record<ListCommandesParams["sort"], string> = {
  created_at: "cf.created_at",
  date_besoin: "cf.date_besoin",
  date_promesse: "cf.date_promesse",
  code: "cf.code",
  total_ttc: "cf.total_ttc",
  updated_at: "cf.updated_at",
};

const ACTIVE_STATUTS_FOR_LATE: readonly CommandeFournisseurStatut[] = [
  "ENVOYEE",
  "ACCUSE_RECU",
  "PARTIELLEMENT_RECUE",
];

export async function repoListCommandesFournisseurs(
  params: ListCommandesParams,
  options: { includePrices: boolean }
): Promise<Paginated<CommandeFournisseurListItem>> {
  const values: unknown[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where: string[] = [];

  if (params.q) {
    const p = push(`%${params.q}%`);
    where.push(
      `(cf.code ILIKE ${p} OR cf.reference_fournisseur ILIKE ${p} OR f.nom ILIKE ${p} OR f.raison_sociale ILIKE ${p}
        OR EXISTS (SELECT 1 FROM public.commande_fournisseur_ligne lq
                   WHERE lq.commande_id = cf.id
                     AND (lq.designation ILIKE ${p} OR lq.reference_fournisseur ILIKE ${p})))`
    );
  }
  const statuts = Array.isArray(params.statut) ? params.statut : params.statut ? [params.statut] : [];
  if (statuts.length > 0) where.push(`cf.statut = ANY(${push(statuts)})`);
  if (params.fournisseur_id) where.push(`cf.fournisseur_id = ${push(params.fournisseur_id)}::uuid`);
  if (params.origine) where.push(`cf.origine = ${push(params.origine)}`);
  if (params.date_from) where.push(`cf.created_at >= ${push(params.date_from)}::date`);
  if (params.date_to) where.push(`cf.created_at < (${push(params.date_to)}::date + 1)`);
  if (params.en_retard === "true") {
    where.push(
      `(cf.date_promesse IS NOT NULL AND cf.date_promesse < CURRENT_DATE AND cf.statut = ANY(${push(ACTIVE_STATUTS_FOR_LATE)}))`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = `ORDER BY ${SORT_COLUMNS[params.sort]} ${params.dir === "asc" ? "ASC" : "DESC"} NULLS LAST, cf.id`;
  const offset = (params.page - 1) * params.page_size;

  const listSql = `
    SELECT cf.id, cf.code, cf.statut, cf.origine, cf.devise,
           cf.date_besoin::text, cf.date_promesse::text, cf.date_envoi::text,
           cf.version_document, cf.created_at::text, cf.updated_at::text,
           cf.total_ht::text, cf.total_ttc::text,
           f.id AS f_id, COALESCE(f.code, f.code_fournisseur) AS f_code,
           COALESCE(f.nom, f.raison_sociale) AS f_nom, f.status AS f_status, f.actif AS f_actif,
           (cf.date_promesse IS NOT NULL AND cf.date_promesse < CURRENT_DATE
             AND cf.statut IN ('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE')) AS en_retard,
           lg.nb_lignes, lg.qty_commandee::text, COALESCE(rc.qty_recue, 0)::text AS qty_recue,
           count(*) OVER() AS total_count
      FROM public.commande_fournisseur cf
      JOIN public.fournisseurs f ON f.id = cf.fournisseur_id
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE l.statut_ligne = 'ACTIVE') AS nb_lignes,
               COALESCE(sum(l.quantite - l.qty_annulee) FILTER (WHERE l.statut_ligne = 'ACTIVE'), 0) AS qty_commandee
          FROM public.commande_fournisseur_ligne l WHERE l.commande_id = cf.id
      ) lg ON TRUE
      LEFT JOIN LATERAL (
        SELECT sum(rl.qty_received) AS qty_recue
          FROM public.reception_fournisseur_lignes rl
          JOIN public.commande_fournisseur_ligne l2 ON l2.id = rl.commande_fournisseur_ligne_id
         WHERE l2.commande_id = cf.id
      ) rc ON TRUE
      ${whereSql}
      ${orderSql}
      LIMIT ${push(params.page_size)} OFFSET ${push(offset)}`;

  const res = await db.query(listSql, values);
  const total = res.rows.length > 0 ? Number(res.rows[0].total_count) : 0;

  const items: CommandeFournisseurListItem[] = res.rows.map((r) => ({
    id: r.id,
    code: r.code,
    statut: r.statut,
    origine: r.origine,
    fournisseur: { id: r.f_id, code: r.f_code, nom: r.f_nom, status: r.f_status, actif: r.f_actif },
    devise: r.devise,
    date_besoin: r.date_besoin,
    date_promesse: r.date_promesse,
    date_envoi: r.date_envoi,
    en_retard: Boolean(r.en_retard),
    nb_lignes: Number(r.nb_lignes ?? 0),
    qty_commandee: num(r.qty_commandee),
    qty_recue: num(r.qty_recue),
    total_ht: options.includePrices ? numOrNull(r.total_ht) : null,
    total_ttc: options.includePrices ? numOrNull(r.total_ttc) : null,
    version_document: Number(r.version_document ?? 0),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  return { items, total, page: params.page, page_size: params.page_size };
}

export async function repoGetKpis(): Promise<CommandeFournisseurKpis> {
  const res = await db.query<{
    brouillons: string;
    a_valider: string;
    a_envoyer: string;
    sans_accuse: string;
    en_retard: string;
    a_recevoir: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE statut = 'BROUILLON')  AS brouillons,
       count(*) FILTER (WHERE statut = 'A_VALIDER')  AS a_valider,
       count(*) FILTER (WHERE statut = 'APPROUVEE')  AS a_envoyer,
       count(*) FILTER (WHERE statut = 'ENVOYEE')    AS sans_accuse,
       count(*) FILTER (WHERE date_promesse IS NOT NULL AND date_promesse < CURRENT_DATE
                          AND statut IN ('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE')) AS en_retard,
       count(*) FILTER (WHERE statut IN ('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE')) AS a_recevoir
     FROM public.commande_fournisseur`
  );
  const r = res.rows[0];
  return {
    brouillons: num(r?.brouillons),
    a_valider: num(r?.a_valider),
    a_envoyer: num(r?.a_envoyer),
    sans_accuse: num(r?.sans_accuse),
    en_retard: num(r?.en_retard),
    a_recevoir: num(r?.a_recevoir),
  };
}

/* ------------------------------------ get ------------------------------------ */

async function fetchLignes(tx: DbQueryer, commandeId: string): Promise<CommandeFournisseurLigne[]> {
  const res = await tx.query(
    `SELECT l.*, l.quantite::text AS quantite_t, l.prix_unitaire_ht::text AS pu_t,
            l.remise_pct::text AS remise_t, l.tva_pct::text AS tva_t, l.frais_ht::text AS frais_t,
            l.coef_conversion::text AS coef_t, l.qty_confirmee::text AS qtyc_t, l.qty_annulee::text AS qtya_t,
            l.date_besoin::text AS date_besoin_t, l.date_promesse::text AS date_promesse_t,
            a.code AS article_code, a.designation AS article_designation,
            COALESCE(rc.qty_recue, 0)::text AS qty_recue_t,
            COALESCE(rc.qty_nc, 0)::text AS qty_nc_t
       FROM public.commande_fournisseur_ligne l
       LEFT JOIN public.articles a ON a.id = l.article_id
       LEFT JOIN LATERAL (
         SELECT sum(rl.qty_received) AS qty_recue,
                sum(CASE WHEN lo.lot_status IN ('BLOQUE','QUARANTAINE') THEN rl.qty_received ELSE 0 END) AS qty_nc
           FROM public.reception_fournisseur_lignes rl
           LEFT JOIN public.lots lo ON lo.id = rl.lot_id
          WHERE rl.commande_fournisseur_ligne_id = l.id
       ) rc ON TRUE
      WHERE l.commande_id = $1::uuid
      ORDER BY l.position, l.created_at`,
    [commandeId]
  );

  const ids = res.rows.map((r) => r.id);
  const besoinsByLigne = new Map<string, CommandeFournisseurLigne["besoins"]>();
  if (ids.length > 0) {
    const besoins = await tx.query(
      `SELECT id, ligne_id, besoin_type, besoin_ref, of_id, quantite_couverte::text AS q, annule
         FROM public.commande_fournisseur_ligne_besoin WHERE ligne_id = ANY($1::uuid[]) ORDER BY created_at`,
      [ids]
    );
    for (const b of besoins.rows) {
      const list = besoinsByLigne.get(b.ligne_id) ?? [];
      list.push({
        id: b.id,
        besoin_type: b.besoin_type,
        besoin_ref: b.besoin_ref,
        of_id: b.of_id == null ? null : Number(b.of_id),
        quantite_couverte: num(b.q),
        annule: Boolean(b.annule),
      });
      besoinsByLigne.set(b.ligne_id, list);
    }
  }

  return res.rows.map((r) => {
    const quantite = num(r.quantite_t);
    const qtyAnnulee = num(r.qtya_t);
    const qtyRecue = num(r.qty_recue_t);
    const net = computeLigneTotaux({
      quantite,
      prix_unitaire_ht: num(r.pu_t),
      remise_pct: num(r.remise_t),
      tva_pct: num(r.tva_t),
      frais_ht: num(r.frais_t),
    }).net_ht;
    return {
      id: r.id,
      commande_id: r.commande_id,
      position: Number(r.position),
      type: r.type,
      article_id: r.article_id,
      article_code: r.article_code ?? null,
      article_designation: r.article_designation ?? null,
      catalogue_id: r.catalogue_id,
      reference_fournisseur: r.reference_fournisseur,
      designation: r.designation,
      designation_interne: r.designation_interne,
      unite: r.unite,
      unite_stock: r.unite_stock,
      coef_conversion: numOrNull(r.coef_t),
      quantite,
      prix_unitaire_ht: num(r.pu_t),
      remise_pct: num(r.remise_t),
      tva_pct: num(r.tva_t),
      frais_ht: num(r.frais_t),
      net_ht: net,
      date_besoin: r.date_besoin_t,
      date_promesse: r.date_promesse_t,
      delai_jours: r.delai_jours == null ? null : Number(r.delai_jours),
      affaire_id: r.affaire_id == null ? null : Number(r.affaire_id),
      commande_client_id: r.commande_client_id == null ? null : Number(r.commande_client_id),
      of_id: r.of_id == null ? null : Number(r.of_id),
      piece_technique_id: r.piece_technique_id,
      operation_libelle: r.operation_libelle,
      magasin_id: r.magasin_id,
      exigences_qualite: Array.isArray(r.exigences_qualite) ? r.exigences_qualite : [],
      documents_attendus: Array.isArray(r.documents_attendus) ? r.documents_attendus : [],
      qty_confirmee: numOrNull(r.qtyc_t),
      qty_recue: qtyRecue,
      qty_recue_nc: num(r.qty_nc_t),
      qty_annulee: qtyAnnulee,
      qty_restante: Math.max(0, roundMoney(quantite - qtyAnnulee - qtyRecue)),
      statut_ligne: r.statut_ligne,
      motif_annulation: r.motif_annulation,
      besoins: besoinsByLigne.get(r.id) ?? [],
    };
  });
}

async function fetchReceptionsLiees(tx: DbQueryer, commandeId: string): Promise<CommandeFournisseurReceptionLiee[]> {
  const res = await tx.query(
    `SELECT r.id AS reception_id, r.reception_no, r.status, r.reception_date::text,
            rl.id AS reception_ligne_id, rl.commande_fournisseur_ligne_id, rl.article_id,
            rl.qty_received::text AS qty_t, rl.lot_id, lo.lot_status AS lot_status
       FROM public.receptions_fournisseurs r
       JOIN public.reception_fournisseur_lignes rl ON rl.reception_id = r.id
       LEFT JOIN public.lots lo ON lo.id = rl.lot_id
      WHERE r.commande_fournisseur_id = $1::uuid
         OR rl.commande_fournisseur_ligne_id IN (
              SELECT id FROM public.commande_fournisseur_ligne WHERE commande_id = $1::uuid)
      ORDER BY r.reception_date DESC, r.reception_no, rl.line_no`,
    [commandeId]
  );
  const map = new Map<string, CommandeFournisseurReceptionLiee>();
  for (const r of res.rows) {
    let entry = map.get(r.reception_id);
    if (!entry) {
      entry = {
        reception_id: r.reception_id,
        reception_no: r.reception_no,
        status: r.status,
        reception_date: r.reception_date,
        lignes: [],
      };
      map.set(r.reception_id, entry);
    }
    entry.lignes.push({
      reception_ligne_id: r.reception_ligne_id,
      commande_fournisseur_ligne_id: r.commande_fournisseur_ligne_id,
      article_id: r.article_id,
      qty_received: num(r.qty_t),
      lot_id: r.lot_id,
      lot_status: r.lot_status ?? null,
    });
  }
  return Array.from(map.values());
}

export async function repoGetCommandeFournisseur(
  id: string,
  options: { includePrices: boolean }
): Promise<CommandeFournisseur> {
  const res = await db.query(
    `SELECT cf.*, cf.created_at::text AS created_at_t, cf.updated_at::text AS updated_at_t,
            cf.date_besoin::text AS date_besoin_t, cf.date_promesse::text AS date_promesse_t,
            cf.date_envoi::text AS date_envoi_t, cf.date_accuse::text AS date_accuse_t,
            cf.date_cloture::text AS date_cloture_t, cf.date_annulation::text AS date_annulation_t,
            cf.total_ht::text AS total_ht_t, cf.total_remise::text AS total_remise_t,
            cf.total_tva::text AS total_tva_t, cf.total_ttc::text AS total_ttc_t,
            cf.frais_port_ht::text AS frais_port_t, cf.tva_frais_pct::text AS tva_frais_t,
            f.id AS f_id, COALESCE(f.code, f.code_fournisseur) AS f_code,
            COALESCE(f.nom, f.raison_sociale) AS f_nom, f.status AS f_status, f.actif AS f_actif
       FROM public.commande_fournisseur cf
       JOIN public.fournisseurs f ON f.id = cf.fournisseur_id
      WHERE cf.id = $1::uuid`,
    [id]
  );
  const r = res.rows[0];
  if (!r) throw new HttpError(404, "COMMANDE_FOURNISSEUR_NOT_FOUND", "Commande fournisseur introuvable.");

  const [lignes, receptions, transitions, documents] = await Promise.all([
    fetchLignes(db, id),
    fetchReceptionsLiees(db, id),
    db.query(
      `SELECT t.id, t.from_statut, t.to_statut, t.motif, t.acteur_id, t.created_at::text,
              trim(concat(u.name, ' ', u.surname)) AS acteur_nom
         FROM public.commande_fournisseur_transition t
         LEFT JOIN public.users u ON u.id = t.acteur_id
        WHERE t.commande_id = $1::uuid ORDER BY t.created_at DESC, t.id DESC`,
      [id]
    ),
    db.query(
      `SELECT id, version, titre, sha256, motif_revision, generated_by, created_at::text, sent_at::text
         FROM public.commande_fournisseur_document WHERE commande_id = $1::uuid ORDER BY version DESC`,
      [id]
    ),
  ]);

  const includePrices = options.includePrices;
  const maskedLignes = includePrices
    ? lignes
    : lignes.map((l) => ({ ...l, prix_unitaire_ht: null, remise_pct: null, frais_ht: null, net_ht: null }));

  return {
    id: r.id,
    code: r.code,
    statut: r.statut,
    origine: r.origine,
    fournisseur: { id: r.f_id, code: r.f_code, nom: r.f_nom, status: r.f_status, actif: r.f_actif },
    contact_id: r.contact_id,
    adresse_commande_id: r.adresse_commande_id,
    magasin_livraison_id: r.magasin_livraison_id,
    adresse_livraison_texte: r.adresse_livraison_texte,
    adresse_facturation_texte: r.adresse_facturation_texte,
    devise: r.devise,
    conditions_paiement: r.conditions_paiement,
    incoterm: r.incoterm,
    mode_transport: r.mode_transport,
    date_besoin: r.date_besoin_t,
    date_promesse: r.date_promesse_t,
    date_envoi: r.date_envoi_t,
    date_accuse: r.date_accuse_t,
    date_cloture: r.date_cloture_t,
    date_annulation: r.date_annulation_t,
    reference_fournisseur: r.reference_fournisseur,
    commentaire_public: r.commentaire_public,
    note_interne: r.note_interne,
    motif_revision: r.motif_revision,
    motif_annulation: r.motif_annulation,
    motif_cloture: r.motif_cloture,
    version_document: Number(r.version_document ?? 0),
    fournisseur_snapshot: r.fournisseur_snapshot ?? null,
    conditions_snapshot: r.conditions_snapshot ?? null,
    total_ht: includePrices ? numOrNull(r.total_ht_t) : null,
    total_remise: includePrices ? numOrNull(r.total_remise_t) : null,
    total_tva: includePrices ? numOrNull(r.total_tva_t) : null,
    frais_port_ht: includePrices ? numOrNull(r.frais_port_t) : null,
    tva_frais_pct: includePrices ? numOrNull(r.tva_frais_t) : null,
    total_ttc: includePrices ? numOrNull(r.total_ttc_t) : null,
    prices_masked: !includePrices,
    allowed_transitions: [...allowedTargetsFrom(r.statut as CommandeFournisseurStatut)],
    lignes: maskedLignes,
    transitions: transitions.rows.map((t) => ({
      id: t.id,
      from_statut: t.from_statut,
      to_statut: t.to_statut,
      motif: t.motif,
      acteur_id: t.acteur_id == null ? null : Number(t.acteur_id),
      acteur_nom: t.acteur_nom || null,
      created_at: t.created_at,
    })),
    documents: documents.rows.map((d) => ({
      id: d.id,
      version: Number(d.version),
      titre: d.titre,
      sha256: d.sha256,
      motif_revision: d.motif_revision,
      generated_by: d.generated_by == null ? null : Number(d.generated_by),
      created_at: d.created_at,
      sent_at: d.sent_at,
    })),
    receptions,
    created_at: r.created_at_t,
    updated_at: r.updated_at_t,
    created_by: r.created_by == null ? null : Number(r.created_by),
    submitted_by: r.submitted_by == null ? null : Number(r.submitted_by),
    approved_by: r.approved_by == null ? null : Number(r.approved_by),
    sent_by: r.sent_by == null ? null : Number(r.sent_by),
  };
}

/* ----------------------------------- create ----------------------------------- */

async function insertLigneTx(
  tx: DbQueryer,
  commandeId: string,
  position: number,
  ligne: CreateCommandeBodyDTO["lignes"][number],
  userId: number
): Promise<string> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO public.commande_fournisseur_ligne (
        commande_id, position, type, article_id, catalogue_id, reference_fournisseur,
        designation, designation_interne, unite, unite_stock, coef_conversion,
        quantite, prix_unitaire_ht, remise_pct, tva_pct, frais_ht,
        date_besoin, date_promesse, delai_jours,
        affaire_id, commande_client_id, of_id, piece_technique_id, operation_libelle, magasin_id,
        exigences_qualite, documents_attendus, created_by, updated_by)
     VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17::date,$18::date,$19,$20,$21,$22,$23::uuid,$24,$25::uuid,$26::jsonb,$27,$28,$28)
     RETURNING id`,
    [
      commandeId,
      position,
      ligne.type,
      ligne.article_id ?? null,
      ligne.catalogue_id ?? null,
      ligne.reference_fournisseur ?? null,
      ligne.designation,
      ligne.designation_interne ?? null,
      ligne.unite ?? null,
      ligne.unite_stock ?? null,
      ligne.coef_conversion ?? null,
      ligne.quantite,
      ligne.prix_unitaire_ht,
      ligne.remise_pct,
      ligne.tva_pct,
      ligne.frais_ht,
      ligne.date_besoin ?? null,
      ligne.date_promesse ?? null,
      ligne.delai_jours ?? null,
      ligne.affaire_id ?? null,
      ligne.commande_client_id ?? null,
      ligne.of_id ?? null,
      ligne.piece_technique_id ?? null,
      ligne.operation_libelle ?? null,
      ligne.magasin_id ?? null,
      JSON.stringify(ligne.exigences_qualite ?? []),
      ligne.documents_attendus ?? [],
      userId,
    ]
  );
  const ligneId = res.rows[0].id;

  for (const besoin of ligne.besoins ?? []) {
    try {
      await tx.query(
        `INSERT INTO public.commande_fournisseur_ligne_besoin
           (ligne_id, besoin_type, besoin_ref, besoin_of_id, of_id, quantite_couverte)
         VALUES ($1::uuid,$2,$3,$4,$5,$6)`,
        [ligneId, besoin.besoin_type, besoin.besoin_ref, besoin.of_id ?? 0, besoin.of_id ?? null, besoin.quantite_couverte]
      );
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw new HttpError(
          409,
          "BESOIN_DEJA_COUVERT",
          `Le besoin ${besoin.besoin_ref} est déjà couvert par une autre ligne de commande vivante.`
        );
      }
      throw err;
    }
  }
  return ligneId;
}

async function readIdempotentReplay(
  tx: DbQueryer,
  key: string,
  action: "CREATE" | "GENERATE" | "SEND"
): Promise<Record<string, unknown> | null> {
  const res = await tx.query<{ action: string; resultat: Record<string, unknown> }>(
    `SELECT action, resultat FROM public.commande_fournisseur_idempotence WHERE cle = $1`,
    [key]
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.action !== action) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé d'idempotence a déjà servi à une autre action.");
  }
  return { ...row.resultat, idempotent_replay: true };
}

async function recordIdempotence(
  tx: DbQueryer,
  key: string,
  action: "CREATE" | "GENERATE" | "SEND",
  commandeId: string | null,
  resultat: Record<string, unknown>
) {
  await tx.query(
    `INSERT INTO public.commande_fournisseur_idempotence (cle, action, commande_id, resultat)
     VALUES ($1,$2,$3::uuid,$4::jsonb) ON CONFLICT (cle) DO NOTHING`,
    [key, action, commandeId, JSON.stringify(resultat)]
  );
}

export async function repoCreateCommandeFournisseur(
  body: CreateCommandeBodyDTO,
  audit: AuditContext
): Promise<{ id: string; code: string; idempotent_replay: boolean }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    if (body.idempotency_key) {
      const replay = await readIdempotentReplay(client, body.idempotency_key, "CREATE");
      if (replay) {
        await client.query("COMMIT");
        return replay as { id: string; code: string; idempotent_replay: boolean };
      }
    }

    const fournisseur = await fetchFournisseurMini(client, body.fournisseur_id);
    assertFournisseurCommandable(fournisseur);

    const code = await generateCommandeFournisseurCode(client);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.commande_fournisseur (
          code, origine, fournisseur_id, contact_id, adresse_commande_id, magasin_livraison_id,
          adresse_livraison_texte, adresse_facturation_texte, devise, conditions_paiement, incoterm,
          mode_transport, date_besoin, commentaire_public, note_interne, frais_port_ht, tva_frais_pct,
          idempotency_key, created_by, updated_by)
       VALUES ($1,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,$11,$12,$13::date,$14,$15,$16,$17,$18,$19,$19)
       RETURNING id`,
      [
        code,
        body.origine,
        body.fournisseur_id,
        body.contact_id ?? null,
        body.adresse_commande_id ?? null,
        body.magasin_livraison_id ?? null,
        body.adresse_livraison_texte ?? null,
        body.adresse_facturation_texte ?? null,
        body.devise,
        body.conditions_paiement ?? null,
        body.incoterm ?? null,
        body.mode_transport ?? null,
        body.date_besoin ?? null,
        body.commentaire_public ?? null,
        body.note_interne ?? null,
        body.frais_port_ht,
        body.tva_frais_pct,
        body.idempotency_key ?? null,
        audit.user_id,
      ]
    );
    const id = inserted.rows[0].id;

    let position = 1;
    for (const ligne of body.lignes) {
      await insertLigneTx(client, id, position, ligne, audit.user_id);
      position += 1;
    }

    await recomputeTotauxTx(client, id);
    await insertTransitionRow(client, id, null, "BROUILLON", null, audit.user_id);
    await insertAuditLog(client, audit, {
      action: "commandes_fournisseurs.create",
      entity_type: "commande_fournisseur",
      entity_id: id,
      details: { code, origine: body.origine, fournisseur_id: body.fournisseur_id, nb_lignes: body.lignes.length },
    });

    const resultat = { id, code, idempotent_replay: false };
    if (body.idempotency_key) {
      await recordIdempotence(client, body.idempotency_key, "CREATE", id, { id, code });
    }
    await client.query("COMMIT");
    return resultat;
  } catch (err) {
    await client.query("ROLLBACK");
    // Double-clic concurrent : la même clé a gagné dans une autre transaction -> rejouer.
    if (body.idempotency_key && isPgUniqueViolation(err)) {
      const replayRes = await db.query<{ id: string; code: string }>(
        `SELECT id, code FROM public.commande_fournisseur WHERE idempotency_key = $1`,
        [body.idempotency_key]
      );
      const row = replayRes.rows[0];
      if (row) return { id: row.id, code: row.code, idempotent_replay: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

/* --------------------------------- update draft -------------------------------- */

function assertDraft(statut: CommandeFournisseurStatut) {
  if (statut !== "BROUILLON") {
    throw new HttpError(
      422,
      "DRAFT_ONLY",
      "Seul un brouillon est modifiable. Une commande engagée passe par une transition ou une révision documentaire motivée."
    );
  }
}

const HEADER_PATCH_COLUMNS: Record<string, string> = {
  contact_id: "contact_id",
  adresse_commande_id: "adresse_commande_id",
  magasin_livraison_id: "magasin_livraison_id",
  adresse_livraison_texte: "adresse_livraison_texte",
  adresse_facturation_texte: "adresse_facturation_texte",
  devise: "devise",
  conditions_paiement: "conditions_paiement",
  incoterm: "incoterm",
  mode_transport: "mode_transport",
  date_besoin: "date_besoin",
  commentaire_public: "commentaire_public",
  note_interne: "note_interne",
  frais_port_ht: "frais_port_ht",
  tva_frais_pct: "tva_frais_pct",
  origine: "origine",
};

export async function repoUpdateCommandeFournisseur(
  id: string,
  body: UpdateCommandeBodyDTO,
  audit: AuditContext
): Promise<{ updated: true }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const header = await lockHeader(client, id);
    assertOptimisticToken(body.expected_updated_at, header.updated_at_token);
    assertDraft(header.statut);

    const sets: string[] = [];
    const values: unknown[] = [id];
    const changed: string[] = [];
    for (const [key, column] of Object.entries(HEADER_PATCH_COLUMNS)) {
      if (!(key in body)) continue; // tri-state : seules les clés fournies changent
      values.push((body as Record<string, unknown>)[key] ?? null);
      sets.push(`${column} = $${values.length}`);
      changed.push(key);
    }
    if (sets.length > 0) {
      values.push(audit.user_id);
      sets.push(`updated_by = $${values.length}`);
      await client.query(`UPDATE public.commande_fournisseur SET ${sets.join(", ")} WHERE id = $1::uuid`, values);
      await recomputeTotauxTx(client, id);
      await insertAuditLog(client, audit, {
        action: "commandes_fournisseurs.update",
        entity_type: "commande_fournisseur",
        entity_id: id,
        details: { champs: changed },
      });
    }
    await client.query("COMMIT");
    return { updated: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------ lignes ----------------------------------- */

export async function repoAddLigne(id: string, body: AddLigneBodyDTO, audit: AuditContext): Promise<{ ligne_id: string }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const header = await lockHeader(client, id);
    assertOptimisticToken(body.expected_updated_at, header.updated_at_token);
    assertDraft(header.statut);

    const posRes = await client.query<{ next_pos: number }>(
      `SELECT COALESCE(max(position), 0) + 1 AS next_pos FROM public.commande_fournisseur_ligne WHERE commande_id = $1::uuid`,
      [id]
    );
    const ligneId = await insertLigneTx(client, id, Number(posRes.rows[0].next_pos), body.ligne, audit.user_id);
    await recomputeTotauxTx(client, id);
    await client.query(`UPDATE public.commande_fournisseur SET updated_by = $2 WHERE id = $1::uuid`, [id, audit.user_id]);
    await insertAuditLog(client, audit, {
      action: "commandes_fournisseurs.lignes.add",
      entity_type: "commande_fournisseur",
      entity_id: id,
      details: { ligne_id: ligneId, designation: body.ligne.designation },
    });
    await client.query("COMMIT");
    return { ligne_id: ligneId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const LIGNE_PATCH_COLUMNS: Record<string, string> = {
  type: "type",
  article_id: "article_id",
  catalogue_id: "catalogue_id",
  reference_fournisseur: "reference_fournisseur",
  designation: "designation",
  designation_interne: "designation_interne",
  unite: "unite",
  unite_stock: "unite_stock",
  coef_conversion: "coef_conversion",
  quantite: "quantite",
  prix_unitaire_ht: "prix_unitaire_ht",
  remise_pct: "remise_pct",
  tva_pct: "tva_pct",
  frais_ht: "frais_ht",
  date_besoin: "date_besoin",
  date_promesse: "date_promesse",
  delai_jours: "delai_jours",
  affaire_id: "affaire_id",
  commande_client_id: "commande_client_id",
  of_id: "of_id",
  piece_technique_id: "piece_technique_id",
  operation_libelle: "operation_libelle",
  magasin_id: "magasin_id",
  exigences_qualite: "exigences_qualite",
  documents_attendus: "documents_attendus",
};

export async function repoUpdateLigne(
  id: string,
  ligneId: string,
  body: UpdateLigneBodyDTO,
  audit: AuditContext
): Promise<{ updated: true }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const header = await lockHeader(client, id);
    assertOptimisticToken(body.expected_updated_at, header.updated_at_token);
    assertDraft(header.statut);

    const exists = await client.query<{ id: string }>(
      `SELECT id FROM public.commande_fournisseur_ligne WHERE id = $1::uuid AND commande_id = $2::uuid FOR UPDATE`,
      [ligneId, id]
    );
    if (!exists.rows[0]) throw new HttpError(404, "LIGNE_NOT_FOUND", "Ligne introuvable sur cette commande.");

    const sets: string[] = [];
    const values: unknown[] = [ligneId];
    for (const [key, column] of Object.entries(LIGNE_PATCH_COLUMNS)) {
      if (!(key in body.patch)) continue;
      const raw = (body.patch as Record<string, unknown>)[key];
      const value = key === "exigences_qualite" ? JSON.stringify(raw ?? []) : raw ?? null;
      values.push(value);
      sets.push(`${column} = $${values.length}${key === "exigences_qualite" ? "::jsonb" : ""}`);
    }
    if (sets.length > 0) {
      values.push(audit.user_id);
      sets.push(`updated_by = $${values.length}`);
      await client.query(
        `UPDATE public.commande_fournisseur_ligne SET ${sets.join(", ")} WHERE id = $1::uuid`,
        values
      );
      await recomputeTotauxTx(client, id);
      await client.query(`UPDATE public.commande_fournisseur SET updated_by = $2 WHERE id = $1::uuid`, [id, audit.user_id]);
      await insertAuditLog(client, audit, {
        action: "commandes_fournisseurs.lignes.update",
        entity_type: "commande_fournisseur",
        entity_id: id,
        details: { ligne_id: ligneId, champs: Object.keys(body.patch) },
      });
    }
    await client.query("COMMIT");
    return { updated: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoDeleteLigne(
  id: string,
  ligneId: string,
  expectedUpdatedAt: string | undefined,
  audit: AuditContext
): Promise<{ deleted: true }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const header = await lockHeader(client, id);
    assertOptimisticToken(expectedUpdatedAt, header.updated_at_token);
    assertDraft(header.statut);

    // Suppression physique UNIQUEMENT en brouillon (rien n'a été engagé) : les liens besoins
    // tombent en cascade et libèrent la couverture. Après soumission, une ligne s'annule.
    const res = await client.query(
      `DELETE FROM public.commande_fournisseur_ligne WHERE id = $1::uuid AND commande_id = $2::uuid`,
      [ligneId, id]
    );
    if (res.rowCount === 0) throw new HttpError(404, "LIGNE_NOT_FOUND", "Ligne introuvable sur cette commande.");
    await recomputeTotauxTx(client, id);
    await client.query(`UPDATE public.commande_fournisseur SET updated_by = $2 WHERE id = $1::uuid`, [id, audit.user_id]);
    await insertAuditLog(client, audit, {
      action: "commandes_fournisseurs.lignes.delete",
      entity_type: "commande_fournisseur",
      entity_id: id,
      details: { ligne_id: ligneId },
    });
    await client.query("COMMIT");
    return { deleted: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function repoReorderLignes(
  id: string,
  body: ReorderLignesBodyDTO,
  audit: AuditContext
): Promise<{ reordered: true }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const header = await lockHeader(client, id);
    assertOptimisticToken(body.expected_updated_at, header.updated_at_token);
    assertDraft(header.statut);

    const current = await client.query<{ id: string }>(
      `SELECT id FROM public.commande_fournisseur_ligne WHERE commande_id = $1::uuid`,
      [id]
    );
    const currentIds = new Set(current.rows.map((r) => r.id));
    if (currentIds.size !== body.ordre.length || body.ordre.some((l) => !currentIds.has(l))) {
      throw new HttpError(422, "REORDER_MISMATCH", "L'ordre fourni ne correspond pas aux lignes de la commande.");
    }
    // La contrainte UNIQUE (commande_id, position) est DEFERRABLE : le swap transactionnel passe.
    for (let index = 0; index < body.ordre.length; index += 1) {
      await client.query(`UPDATE public.commande_fournisseur_ligne SET position = $2 WHERE id = $1::uuid`, [
        body.ordre[index],
        index + 1,
      ]);
    }
    await client.query(`UPDATE public.commande_fournisseur SET updated_by = $2 WHERE id = $1::uuid`, [id, audit.user_id]);
    await insertAuditLog(client, audit, {
      action: "commandes_fournisseurs.lignes.reorder",
      entity_type: "commande_fournisseur",
      entity_id: id,
      details: { nb_lignes: body.ordre.length },
    });
    await client.query("COMMIT");
    return { reordered: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ---------------------------------- transitions --------------------------------- */

async function buildFournisseurSnapshot(tx: DbQueryer, fournisseurId: string): Promise<Record<string, unknown>> {
  const f = await tx.query(
    `SELECT id, COALESCE(code, code_fournisseur) AS code, COALESCE(nom, raison_sociale) AS nom,
            status, actif, email, telephone
       FROM public.fournisseurs WHERE id = $1::uuid`,
    [fournisseurId]
  );
  const adresses = await tx.query(
    `SELECT type, label, ligne1, ligne2, house_no, postcode, city, country, is_primary
       FROM public.fournisseur_adresses WHERE fournisseur_id = $1::uuid AND actif IS NOT FALSE
       ORDER BY type, is_primary DESC NULLS LAST`,
    [fournisseurId]
  ).catch(() => ({ rows: [] as unknown[] }));
  return { fournisseur: f.rows[0] ?? null, adresses: adresses.rows, snapshot_at: new Date().toISOString() };
}

async function countLignesActives(tx: DbQueryer, commandeId: string): Promise<number> {
  const res = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM public.commande_fournisseur_ligne
      WHERE commande_id = $1::uuid AND statut_ligne = 'ACTIVE'`,
    [commandeId]
  );
  return num(res.rows[0]?.n);
}

async function sumQtyRecue(tx: DbQueryer, commandeId: string): Promise<number> {
  const res = await tx.query<{ q: string }>(
    `SELECT COALESCE(sum(rl.qty_received), 0) AS q
       FROM public.reception_fournisseur_lignes rl
       JOIN public.commande_fournisseur_ligne l ON l.id = rl.commande_fournisseur_ligne_id
      WHERE l.commande_id = $1::uuid`,
    [commandeId]
  );
  return num(res.rows[0]?.q);
}

export async function repoTransitionCommandeFournisseur(
  id: string,
  body: TransitionBodyDTO,
  audit: AuditContext,
  options?: { system?: boolean }
): Promise<{ statut: CommandeFournisseurStatut; idempotent_replay?: boolean }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    if (body.idempotency_key) {
      const replay = await readIdempotentReplay(client, body.idempotency_key, "SEND");
      if (replay) {
        await client.query("COMMIT");
        return replay as { statut: CommandeFournisseurStatut; idempotent_replay: boolean };
      }
    }

    const header = await lockHeader(client, id);
    assertOptimisticToken(body.expected_updated_at, header.updated_at_token);

    const from = header.statut;
    const to = body.to;

    if (from === to) {
      // Idempotence naturelle (double-clic) : l'état demandé est déjà atteint, aucune écriture.
      await client.query("COMMIT");
      return { statut: from, idempotent_replay: true };
    }

    if (!isAllowedTransition(from, to)) {
      throw new HttpError(422, "INVALID_TRANSITION", "Transition de statut interdite.", {
        from,
        to,
        allowed: allowedTargetsFrom(from),
      });
    }

    const kind = classifyTransition(from, to);

    // Les états de réception sont dérivés des réceptions réelles, jamais posés à la main.
    if (isReceptionDerivedStatut(to) && !options?.system) {
      throw new HttpError(
        422,
        "RECEPTION_DERIVED_STATUS",
        "Ce statut est calculé depuis les réceptions liées : créez une réception dans le module Réceptions."
      );
    }

    // RBAC fin re-vérifié une fois `from` connu (le garde de route est volontairement coarse).
    if (!options?.system) {
      const capability = capabilityForTransition(kind);
      if (!roleHasCommandeFournisseurCapability(audit.role, capability)) {
        throw new HttpError(403, "FORBIDDEN_TRANSITION", "Votre rôle ne permet pas cette transition.");
      }
    }

    const motif = body.motif?.trim() || null;
    if (transitionRequiresMotif(kind) && !motif) {
      throw new HttpError(422, "MOTIF_REQUIS", "Un motif est obligatoire pour cette transition.", { kind });
    }

    // Préconditions métier par nature de transition.
    if (kind === "submit" || kind === "approve") {
      const nbLignes = await countLignesActives(client, id);
      if (nbLignes === 0) {
        throw new HttpError(422, "COMMANDE_SANS_LIGNE", "Impossible sans au moins une ligne active.");
      }
      const fournisseur = await fetchFournisseurMini(client, header.fournisseur_id);
      assertFournisseurCommandable(fournisseur);
    }
    if (kind === "send") {
      if (Number(header.version_document) < 1) {
        throw new HttpError(
          422,
          "DOCUMENT_VERSION_REQUISE",
          "Impossible d'envoyer sans version figée du bon de commande : générez d'abord le document."
        );
      }
    }
    if (kind === "cancel") {
      const recue = await sumQtyRecue(client, id);
      if (recue > 0) {
        throw new HttpError(
          422,
          "ANNULATION_IMPOSSIBLE_RECEPTIONNEE",
          "Des quantités ont déjà été réceptionnées : clôturez avec motif au lieu d'annuler."
        );
      }
    }
    if (kind === "close" && from === "PARTIELLEMENT_RECUE" && !motif) {
      throw new HttpError(422, "MOTIF_REQUIS", "La clôture avec reliquat exige un motif explicite.");
    }

    // Effets par transition.
    const sets: string[] = [`statut = $2`, `updated_by = $3`];
    const values: unknown[] = [id, to, audit.user_id];
    const pushSet = (fragment: string, value?: unknown) => {
      if (value !== undefined) {
        values.push(value);
        sets.push(`${fragment} $${values.length}`);
      } else {
        sets.push(fragment);
      }
    };

    if (kind === "submit") {
      pushSet("submitted_at = now()");
      pushSet("submitted_by =", audit.user_id);
    }
    if (kind === "approve") {
      pushSet("approved_at = now()");
      pushSet("approved_by =", audit.user_id);
    }
    if (kind === "reject" || kind === "reopen_draft") {
      pushSet("motif_revision =", motif);
    }
    if (kind === "send") {
      const snapshot = await buildFournisseurSnapshot(client, header.fournisseur_id);
      pushSet("date_envoi = now()");
      pushSet("sent_by =", audit.user_id);
      pushSet("fournisseur_snapshot =", JSON.stringify(snapshot));
      pushSet(
        "conditions_snapshot =",
        JSON.stringify({
          devise: header.devise,
          version_document: header.version_document,
          snapshot_at: new Date().toISOString(),
        })
      );
      await client.query(
        `UPDATE public.commande_fournisseur_document SET sent_at = now()
          WHERE commande_id = $1::uuid AND version = $2 AND sent_at IS NULL`,
        [id, header.version_document]
      );
    }
    if (kind === "cancel") {
      pushSet("date_annulation = now()");
      pushSet("motif_annulation =", motif);
    }
    if (kind === "close") {
      pushSet("date_cloture = now()");
      pushSet("motif_cloture =", motif);
    }

    await client.query(`UPDATE public.commande_fournisseur SET ${sets.join(", ")} WHERE id = $1::uuid`, values);
    await insertTransitionRow(client, id, from, to, motif, options?.system ? null : audit.user_id);
    await insertAuditLog(client, audit, {
      action: `commandes_fournisseurs.transition.${kind}`,
      entity_type: "commande_fournisseur",
      entity_id: id,
      details: { from, to, motif, system: Boolean(options?.system) },
    });

    const resultat = { statut: to };
    if (body.idempotency_key) {
      await recordIdempotence(client, body.idempotency_key, "SEND", id, resultat);
    }
    await client.query("COMMIT");
    return resultat;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------ accusé ------------------------------------ */

export async function repoAccuseReception(
  id: string,
  body: AccuseBodyDTO,
  audit: AuditContext
): Promise<{ statut: CommandeFournisseurStatut }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const header = await lockHeader(client, id);
    assertOptimisticToken(body.expected_updated_at, header.updated_at_token);

    if (header.statut !== "ENVOYEE") {
      throw new HttpError(422, "INVALID_TRANSITION", "L'accusé ne peut être saisi que sur une commande envoyée.", {
        from: header.statut,
        to: "ACCUSE_RECU",
        allowed: allowedTargetsFrom(header.statut),
      });
    }

    await client.query(
      `UPDATE public.commande_fournisseur
          SET statut = 'ACCUSE_RECU',
              reference_fournisseur = $2,
              date_accuse = COALESCE($3::timestamptz, now()),
              date_promesse = COALESCE($4::date, date_promesse),
              acknowledged_by = $5,
              updated_by = $5
        WHERE id = $1::uuid`,
      [id, body.reference_fournisseur, body.date_accuse ?? null, body.date_promesse ?? null, audit.user_id]
    );
    await insertTransitionRow(client, id, "ENVOYEE", "ACCUSE_RECU", null, audit.user_id);
    await insertAuditLog(client, audit, {
      action: "commandes_fournisseurs.transition.acknowledge",
      entity_type: "commande_fournisseur",
      entity_id: id,
      details: { reference_fournisseur: body.reference_fournisseur },
    });
    await client.query("COMMIT");
    return { statut: "ACCUSE_RECU" };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ----------------------------------- documents ----------------------------------- */

export async function repoGenerateDocumentVersion(
  id: string,
  motifRevision: string | undefined,
  expectedUpdatedAt: string | undefined,
  audit: AuditContext
): Promise<CommandeFournisseurDocumentMeta> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const header = await lockHeader(client, id);
    assertOptimisticToken(expectedUpdatedAt, header.updated_at_token);

    if (header.statut !== "APPROUVEE") {
      throw new HttpError(
        422,
        "DOCUMENT_STATUT_INVALIDE",
        "La version documentaire se génère sur une commande approuvée (avant envoi)."
      );
    }
    if (Number(header.version_document) >= 1 && !motifRevision) {
      throw new HttpError(422, "MOTIF_REQUIS", "Une nouvelle version documentaire exige un motif de révision.");
    }

    const detail = await repoGetCommandeFournisseurTx(client, id);
    const version = Number(header.version_document) + 1;
    const payload = {
      type: "BON_DE_COMMANDE_FOURNISSEUR",
      version,
      code: detail.code,
      statut: detail.statut,
      fournisseur: detail.fournisseur,
      devise: detail.devise,
      incoterm: detail.incoterm,
      conditions_paiement: detail.conditions_paiement,
      mode_transport: detail.mode_transport,
      date_besoin: detail.date_besoin,
      commentaire_public: detail.commentaire_public,
      lignes: detail.lignes
        .filter((l) => l.statut_ligne === "ACTIVE")
        .map((l) => ({
          position: l.position,
          type: l.type,
          article_code: l.article_code,
          reference_fournisseur: l.reference_fournisseur,
          designation: l.designation,
          unite: l.unite,
          quantite: l.quantite,
          prix_unitaire_ht: l.prix_unitaire_ht,
          remise_pct: l.remise_pct,
          tva_pct: l.tva_pct,
          net_ht: l.net_ht,
          date_besoin: l.date_besoin,
          exigences_qualite: l.exigences_qualite,
          documents_attendus: l.documents_attendus,
        })),
      totaux: {
        total_ht: detail.total_ht,
        total_remise: detail.total_remise,
        total_tva: detail.total_tva,
        frais_port_ht: detail.frais_port_ht,
        total_ttc: detail.total_ttc,
      },
    };
    const canonical = stableStringify(payload);
    const sha = sha256Hex(canonical);

    const inserted = await client.query(
      `INSERT INTO public.commande_fournisseur_document
         (commande_id, version, titre, payload, sha256, motif_revision, generated_by)
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING id, version, titre, sha256, motif_revision, generated_by, created_at::text, sent_at::text`,
      [id, version, `Bon de commande ${detail.code} — v${version}`, canonical, sha, motifRevision ?? null, audit.user_id]
    );
    await client.query(
      `UPDATE public.commande_fournisseur SET version_document = $2, motif_revision = $3, updated_by = $4 WHERE id = $1::uuid`,
      [id, version, motifRevision ?? null, audit.user_id]
    );
    await insertAuditLog(client, audit, {
      action: "commandes_fournisseurs.document.generate",
      entity_type: "commande_fournisseur",
      entity_id: id,
      details: { version, sha256: sha },
    });
    await client.query("COMMIT");
    const d = inserted.rows[0];
    return {
      id: d.id,
      version: Number(d.version),
      titre: d.titre,
      sha256: d.sha256,
      motif_revision: d.motif_revision,
      generated_by: d.generated_by == null ? null : Number(d.generated_by),
      created_at: d.created_at,
      sent_at: d.sent_at,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Variante transactionnelle interne du détail (utilisée par la génération documentaire).
async function repoGetCommandeFournisseurTx(tx: DbQueryer, id: string): Promise<CommandeFournisseur> {
  const res = await tx.query(
    `SELECT cf.*, cf.date_besoin::text AS date_besoin_t,
            cf.total_ht::text AS total_ht_t, cf.total_remise::text AS total_remise_t,
            cf.total_tva::text AS total_tva_t, cf.total_ttc::text AS total_ttc_t,
            cf.frais_port_ht::text AS frais_port_t,
            f.id AS f_id, COALESCE(f.code, f.code_fournisseur) AS f_code,
            COALESCE(f.nom, f.raison_sociale) AS f_nom, f.status AS f_status, f.actif AS f_actif
       FROM public.commande_fournisseur cf
       JOIN public.fournisseurs f ON f.id = cf.fournisseur_id
      WHERE cf.id = $1::uuid`,
    [id]
  );
  const r = res.rows[0];
  if (!r) throw new HttpError(404, "COMMANDE_FOURNISSEUR_NOT_FOUND", "Commande fournisseur introuvable.");
  const lignes = await fetchLignes(tx, id);
  return {
    id: r.id,
    code: r.code,
    statut: r.statut,
    origine: r.origine,
    fournisseur: { id: r.f_id, code: r.f_code, nom: r.f_nom, status: r.f_status, actif: r.f_actif },
    contact_id: r.contact_id,
    adresse_commande_id: r.adresse_commande_id,
    magasin_livraison_id: r.magasin_livraison_id,
    adresse_livraison_texte: r.adresse_livraison_texte,
    adresse_facturation_texte: r.adresse_facturation_texte,
    devise: r.devise,
    conditions_paiement: r.conditions_paiement,
    incoterm: r.incoterm,
    mode_transport: r.mode_transport,
    date_besoin: r.date_besoin_t,
    date_promesse: null,
    date_envoi: null,
    date_accuse: null,
    date_cloture: null,
    date_annulation: null,
    reference_fournisseur: r.reference_fournisseur,
    commentaire_public: r.commentaire_public,
    note_interne: r.note_interne,
    motif_revision: r.motif_revision,
    motif_annulation: r.motif_annulation,
    motif_cloture: r.motif_cloture,
    version_document: Number(r.version_document ?? 0),
    fournisseur_snapshot: r.fournisseur_snapshot ?? null,
    conditions_snapshot: r.conditions_snapshot ?? null,
    total_ht: numOrNull(r.total_ht_t),
    total_remise: numOrNull(r.total_remise_t),
    total_tva: numOrNull(r.total_tva_t),
    frais_port_ht: numOrNull(r.frais_port_t),
    tva_frais_pct: null,
    total_ttc: numOrNull(r.total_ttc_t),
    prices_masked: false,
    allowed_transitions: [...allowedTargetsFrom(r.statut as CommandeFournisseurStatut)],
    lignes,
    transitions: [],
    documents: [],
    receptions: [],
    created_at: "",
    updated_at: "",
    created_by: null,
    submitted_by: null,
    approved_by: null,
    sent_by: null,
  };
}

export async function repoGetDocument(
  id: string,
  documentId: string
): Promise<{ meta: CommandeFournisseurDocumentMeta; payload: unknown }> {
  const res = await db.query(
    `SELECT id, commande_id, version, titre, payload, sha256, motif_revision, generated_by,
            created_at::text, sent_at::text
       FROM public.commande_fournisseur_document
      WHERE id = $1::uuid AND commande_id = $2::uuid`,
    [documentId, id]
  );
  const d = res.rows[0];
  if (!d) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Version documentaire introuvable.");
  return {
    meta: {
      id: d.id,
      version: Number(d.version),
      titre: d.titre,
      sha256: d.sha256,
      motif_revision: d.motif_revision,
      generated_by: d.generated_by == null ? null : Number(d.generated_by),
      created_at: d.created_at,
      sent_at: d.sent_at,
    },
    payload: typeof d.payload === "string" ? JSON.parse(d.payload) : d.payload,
  };
}

/* ------------------------ imputation réceptions (système) ------------------------ */

/**
 * Recalcule l'état de réception d'une commande à partir des réceptions LIÉES (SUM).
 * Appelé dans la MÊME transaction que l'écriture de réception (module réceptions), ou via
 * l'endpoint de resynchronisation idempotent. Contrôle la sur-réception (permission dédiée).
 */
export async function repoRefreshCommandeReceptionState(
  tx: DbQueryer,
  commandeId: string,
  options: { allowOverReceipt: boolean; audit?: AuditContext }
): Promise<{ statut: CommandeFournisseurStatut; changed: boolean }> {
  const headerRes = await tx.query<{ statut: CommandeFournisseurStatut }>(
    `SELECT statut FROM public.commande_fournisseur WHERE id = $1::uuid FOR UPDATE`,
    [commandeId]
  );
  const header = headerRes.rows[0];
  if (!header) throw new HttpError(404, "COMMANDE_FOURNISSEUR_NOT_FOUND", "Commande fournisseur introuvable.");

  const lignes = await tx.query<{
    id: string;
    quantite: string;
    qty_annulee: string;
    statut_ligne: string;
    qty_recue: string;
  }>(
    `SELECT l.id, l.quantite::text, l.qty_annulee::text, l.statut_ligne,
            COALESCE((SELECT sum(rl.qty_received) FROM public.reception_fournisseur_lignes rl
                       WHERE rl.commande_fournisseur_ligne_id = l.id), 0)::text AS qty_recue
       FROM public.commande_fournisseur_ligne l
      WHERE l.commande_id = $1::uuid`,
    [commandeId]
  );

  let totalRecue = 0;
  let resteGlobal = 0;
  for (const l of lignes.rows) {
    if (l.statut_ligne !== "ACTIVE") continue;
    const attendue = num(l.quantite) - num(l.qty_annulee);
    const recue = num(l.qty_recue);
    totalRecue += recue;
    if (recue > attendue && !options.allowOverReceipt) {
      throw new HttpError(422, "OVER_RECEIPT", "Sur-réception détectée sur une ligne de commande.", {
        ligne_id: l.id,
        attendue,
        recue,
      });
    }
    resteGlobal += Math.max(0, attendue - recue);
  }

  let cible: CommandeFournisseurStatut | null = null;
  if (["ENVOYEE", "ACCUSE_RECU", "PARTIELLEMENT_RECUE"].includes(header.statut)) {
    if (totalRecue > 0 && resteGlobal <= 0) cible = "RECUE";
    else if (totalRecue > 0) cible = "PARTIELLEMENT_RECUE";
  }

  if (cible && cible !== header.statut) {
    await tx.query(`UPDATE public.commande_fournisseur SET statut = $2 WHERE id = $1::uuid`, [commandeId, cible]);
    await insertTransitionRow(tx, commandeId, header.statut, cible, "Imputation des réceptions liées", options.audit?.user_id ?? null);
    if (options.audit) {
      await insertAuditLog(tx, options.audit, {
        action: `commandes_fournisseurs.transition.${cible === "RECUE" ? "receive_full" : "receive_partial"}`,
        entity_type: "commande_fournisseur",
        entity_id: commandeId,
        details: { from: header.statut, to: cible, total_recue: totalRecue, reste: resteGlobal, system: true },
      });
    }
    return { statut: cible, changed: true };
  }
  return { statut: (cible ?? header.statut) as CommandeFournisseurStatut, changed: false };
}

/** Resynchronisation manuelle idempotente (bouton fiche / job). */
export async function repoResyncReceptions(
  id: string,
  audit: AuditContext,
  allowOverReceipt: boolean
): Promise<{ statut: CommandeFournisseurStatut; changed: boolean }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await repoRefreshCommandeReceptionState(client, id, { allowOverReceipt, audit });
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ----------------------------------- propositions ---------------------------------- */

export async function repoPreviewPropositions(body: PropositionsPreviewBodyDTO): Promise<PropositionsPreview> {
  const lignes: PropositionLigne[] = [];
  const bloques: PropositionsPreview["bloques"] = [];

  if (body.origines.includes("SEUIL_STOCK")) {
    const res = await db.query(
      `SELECT sl.id AS stock_level_id, sl.article_id, sl.min_qty::text, sl.reorder_qty::text,
              sl.lead_time_days, sl.supplier_id,
              (sl.qty_total - sl.qty_reserved)::text AS disponible,
              a.code AS article_code, a.designation, a.unite,
              f.id AS f_id, COALESCE(f.code, f.code_fournisseur) AS f_code,
              COALESCE(f.nom, f.raison_sociale) AS f_nom, f.status AS f_status, f.actif AS f_actif,
              cat.id AS catalogue_id, cat.prix_unitaire::text AS cat_prix, cat.devise AS cat_devise,
              cat.delai_jours AS cat_delai, cat.moq::text AS cat_moq, cat.actif AS cat_actif,
              cat.fournisseur_id AS cat_fournisseur_id
         FROM public.stock_levels sl
         JOIN public.articles a ON a.id = sl.article_id
         LEFT JOIN public.fournisseurs f ON f.id = sl.supplier_id
         LEFT JOIN LATERAL (
           SELECT c.* FROM public.fournisseur_catalogue c
            WHERE c.article_id = sl.article_id AND c.actif
            ORDER BY (c.fournisseur_id = sl.supplier_id) DESC, c.prix_unitaire ASC NULLS LAST
            LIMIT 1
         ) cat ON TRUE
        WHERE sl.managed_in_stock IS TRUE
          AND sl.min_qty IS NOT NULL AND sl.min_qty > 0
          AND (sl.qty_total - sl.qty_reserved) < sl.min_qty
          AND NOT EXISTS (
            SELECT 1 FROM public.commande_fournisseur_ligne_besoin b
             WHERE b.besoin_type = 'STOCK_LEVEL' AND b.besoin_ref = sl.id::text AND NOT b.annule)
        ORDER BY a.code
        LIMIT $1`,
      [body.limit]
    );
    for (const r of res.rows) {
      const disponible = num(r.disponible);
      const minQty = num(r.min_qty);
      const reorder = num(r.reorder_qty);
      const moq = numOrNull(r.cat_moq);
      let quantite = reorder > 0 ? reorder : roundMoney(minQty - disponible);
      const alertes: string[] = [];
      if (moq != null && quantite < moq) {
        quantite = moq;
        alertes.push("MOQ_APPLIQUE");
      }
      const fournisseurId: string | null = r.f_id ?? r.cat_fournisseur_id ?? null;
      const ligne: PropositionLigne = {
        besoin_type: "STOCK_LEVEL",
        besoin_ref: r.stock_level_id,
        of_id: null,
        of_numero: null,
        article_id: r.article_id,
        article_code: r.article_code,
        designation: r.designation ?? r.article_code ?? "Article",
        type: "ARTICLE",
        quantite,
        unite: r.unite ?? null,
        prix_unitaire_ht: numOrNull(r.cat_prix),
        prix_source: r.catalogue_id ? "CATALOGUE_FOURNISSEUR" : null,
        delai_jours: r.cat_delai ?? r.lead_time_days ?? null,
        date_besoin: null,
        catalogue_id: r.catalogue_id ?? null,
        alertes,
      };
      if (!fournisseurId) {
        bloques.push({ ...ligne, raison: "AUCUN_FOURNISSEUR" });
        continue;
      }
      if (r.f_actif === false || r.f_status === "archive" || r.f_status === "inactif") {
        bloques.push({ ...ligne, raison: "FOURNISSEUR_INACTIF" });
        continue;
      }
      if (ligne.prix_unitaire_ht == null) alertes.push("PRIX_MANQUANT");
      lignes.push({ ...ligne, alertes, ...(r.f_id ? {} : {}) });
      // fournisseur porté via groupement ci-dessous
      (ligne as PropositionLigne & { __fournisseur?: FournisseurMini; __devise?: string }).__fournisseur = {
        id: fournisseurId,
        code: r.f_code ?? null,
        nom: r.f_nom ?? null,
        status: r.f_status ?? null,
        actif: r.f_actif ?? null,
      };
      (ligne as PropositionLigne & { __devise?: string }).__devise = r.cat_devise ?? "EUR";
    }
  }

  if (body.origines.includes("RUPTURE_OF")) {
    const values: unknown[] = [body.limit];
    let ofFilter = `upper(COALESCE(o.statut, '')) NOT IN ('TERMINE','TERMINEE','CLOTURE','CLOTUREE','ANNULE','ANNULEE','ARCHIVE')`;
    if (body.of_ids && body.of_ids.length > 0) {
      values.push(body.of_ids);
      ofFilter = `o.id = ANY($${values.length}::bigint[])`;
    }
    const res = await db.query(
      `SELECT pta.id AS pta_id, pta.nom, pta.designation AS pta_designation, pta.type_achat,
              pta.quantite::text AS pta_quantite, pta.pu_achat::text, pta.tva_achat::text,
              pta.article_id, pta.fournisseur_id AS pta_fournisseur_id,
              o.id AS of_id, o.numero AS of_numero, o.quantite_lancee::text,
              a.code AS article_code, a.designation AS article_designation, a.unite AS article_unite,
              f.id AS f_id, COALESCE(f.code, f.code_fournisseur) AS f_code,
              COALESCE(f.nom, f.raison_sociale) AS f_nom, f.status AS f_status, f.actif AS f_actif,
              cat.id AS catalogue_id, cat.prix_unitaire::text AS cat_prix, cat.devise AS cat_devise,
              cat.delai_jours AS cat_delai, cat.fournisseur_id AS cat_fournisseur_id
         FROM public.ordres_fabrication o
         JOIN public.pieces_techniques_achats pta ON pta.piece_technique_id = o.piece_technique_id
         LEFT JOIN public.articles a ON a.id = pta.article_id
         LEFT JOIN public.fournisseurs f ON f.id = pta.fournisseur_id
         LEFT JOIN LATERAL (
           SELECT c.* FROM public.fournisseur_catalogue c
            WHERE c.article_id = pta.article_id AND c.actif
            ORDER BY (c.fournisseur_id = pta.fournisseur_id) DESC, c.prix_unitaire ASC NULLS LAST
            LIMIT 1
         ) cat ON TRUE
        WHERE ${ofFilter}
          AND NOT EXISTS (
            SELECT 1 FROM public.commande_fournisseur_ligne_besoin b
             WHERE b.besoin_type = 'PIECE_TECHNIQUE_ACHAT'
               AND b.besoin_ref = pta.id::text
               AND b.besoin_of_id = o.id
               AND NOT b.annule)
        ORDER BY o.id DESC, pta.nom
        LIMIT $1`,
      values
    );
    for (const r of res.rows) {
      const parPiece = num(r.pta_quantite) || 1;
      const lancee = num(r.quantite_lancee) || 1;
      const quantite = roundMoney(parPiece * lancee) || parPiece;
      const alertes: string[] = [];
      const typeAchat = String(r.type_achat ?? "").toUpperCase();
      const type =
        typeAchat === "MATIERE"
          ? "MATIERE"
          : typeAchat === "SOUS_TRAITANCE" || typeAchat === "TRAITEMENT"
            ? "SOUS_TRAITANCE"
            : typeAchat === "VISSERIE" || typeAchat === "COMPOSANT_CATALOGUE"
              ? "COMPOSANT"
              : typeAchat === "CERTIFICAT"
                ? "PRESTATION"
                : "ARTICLE";
      const fournisseurId: string | null = r.f_id ?? r.cat_fournisseur_id ?? null;
      const prix = numOrNull(r.cat_prix) ?? numOrNull(r.pu_achat);
      const ligne: PropositionLigne = {
        besoin_type: "PIECE_TECHNIQUE_ACHAT",
        besoin_ref: r.pta_id,
        of_id: Number(r.of_id),
        of_numero: r.of_numero ?? null,
        article_id: r.article_id ?? null,
        article_code: r.article_code ?? null,
        designation: r.pta_designation || r.nom || r.article_designation || "Besoin d'achat",
        type,
        quantite,
        unite: r.article_unite ?? null,
        prix_unitaire_ht: prix,
        prix_source: r.catalogue_id ? "CATALOGUE_FOURNISSEUR" : numOrNull(r.pu_achat) != null ? "NOMENCLATURE_ACHAT" : null,
        delai_jours: r.cat_delai ?? null,
        date_besoin: null,
        catalogue_id: r.catalogue_id ?? null,
        alertes,
      };
      if (!fournisseurId) {
        bloques.push({ ...ligne, raison: "AUCUN_FOURNISSEUR" });
        continue;
      }
      if (r.f_actif === false || r.f_status === "archive" || r.f_status === "inactif") {
        bloques.push({ ...ligne, raison: "FOURNISSEUR_INACTIF" });
        continue;
      }
      if (prix == null) alertes.push("PRIX_MANQUANT");
      (ligne as PropositionLigne & { __fournisseur?: FournisseurMini }).__fournisseur = {
        id: fournisseurId,
        code: r.f_code ?? null,
        nom: r.f_nom ?? null,
        status: r.f_status ?? null,
        actif: r.f_actif ?? null,
      };
      (ligne as PropositionLigne & { __devise?: string }).__devise = r.cat_devise ?? "EUR";
      lignes.push(ligne);
    }
  }

  // Groupement par fournisseur + devise (seules les lignes compatibles voyagent ensemble).
  const groupes = new Map<string, PropositionGroupe>();
  for (const ligne of lignes) {
    const meta = ligne as PropositionLigne & { __fournisseur?: FournisseurMini; __devise?: string };
    const fournisseur = meta.__fournisseur;
    if (!fournisseur) continue;
    if (body.fournisseur_id && fournisseur.id !== body.fournisseur_id) continue;
    const devise = meta.__devise ?? "EUR";
    const key = `${fournisseur.id}:${devise}`;
    let groupe = groupes.get(key);
    if (!groupe) {
      groupe = { fournisseur, devise, lignes: [], total_estime_ht: 0 };
      groupes.set(key, groupe);
    }
    delete meta.__fournisseur;
    delete meta.__devise;
    groupe.lignes.push(ligne);
    if (ligne.prix_unitaire_ht != null && groupe.total_estime_ht != null) {
      groupe.total_estime_ht = roundMoney(groupe.total_estime_ht + ligne.prix_unitaire_ht * ligne.quantite);
    } else {
      groupe.total_estime_ht = groupe.total_estime_ht ?? null;
    }
  }

  return {
    groupes: Array.from(groupes.values()),
    bloques,
    genere_le: new Date().toISOString(),
  };
}

export async function repoConfirmPropositions(
  body: PropositionsConfirmBodyDTO,
  audit: AuditContext
): Promise<{ commandes: Array<{ id: string; code: string; fournisseur_id: string }>; idempotent_replay: boolean }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const replay = await readIdempotentReplay(client, body.idempotency_key, "GENERATE");
    if (replay) {
      await client.query("COMMIT");
      return replay as { commandes: Array<{ id: string; code: string; fournisseur_id: string }>; idempotent_replay: boolean };
    }

    const commandes: Array<{ id: string; code: string; fournisseur_id: string }> = [];
    for (const groupe of body.groupes) {
      const fournisseur = await fetchFournisseurMini(client, groupe.fournisseur_id);
      assertFournisseurCommandable(fournisseur);

      const code = await generateCommandeFournisseurCode(client);
      const origine = groupe.lignes.some((l) => l.besoin_type === "PIECE_TECHNIQUE_ACHAT") ? "RUPTURE_OF" : "SEUIL_STOCK";
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.commande_fournisseur
           (code, origine, fournisseur_id, devise, date_besoin, created_by, updated_by)
         VALUES ($1,$2,$3::uuid,$4,$5::date,$6,$6) RETURNING id`,
        [code, origine, groupe.fournisseur_id, groupe.devise, groupe.date_besoin ?? null, audit.user_id]
      );
      const commandeId = inserted.rows[0].id;

      let position = 1;
      for (const l of groupe.lignes) {
        await insertLigneTx(
          client,
          commandeId,
          position,
          {
            type: l.type,
            article_id: l.article_id ?? null,
            catalogue_id: l.catalogue_id ?? null,
            reference_fournisseur: null,
            designation: l.designation,
            designation_interne: null,
            unite: l.unite ?? null,
            unite_stock: null,
            coef_conversion: null,
            quantite: l.quantite,
            prix_unitaire_ht: l.prix_unitaire_ht,
            remise_pct: 0,
            tva_pct: l.tva_pct,
            frais_ht: 0,
            date_besoin: l.date_besoin ?? null,
            date_promesse: null,
            delai_jours: l.delai_jours ?? null,
            affaire_id: null,
            commande_client_id: null,
            of_id: l.of_id ?? null,
            piece_technique_id: null,
            operation_libelle: null,
            magasin_id: null,
            exigences_qualite: [],
            documents_attendus: [],
            besoins: [
              {
                besoin_type: l.besoin_type,
                besoin_ref: l.besoin_ref,
                of_id: l.of_id ?? null,
                quantite_couverte: l.quantite,
              },
            ],
          },
          audit.user_id
        );
        position += 1;
      }

      await recomputeTotauxTx(client, commandeId);
      await insertTransitionRow(client, commandeId, null, "BROUILLON", "Généré depuis propositions d'achat", audit.user_id);
      await insertAuditLog(client, audit, {
        action: "commandes_fournisseurs.propositions.confirm",
        entity_type: "commande_fournisseur",
        entity_id: commandeId,
        details: { code, fournisseur_id: groupe.fournisseur_id, nb_lignes: groupe.lignes.length, origine },
      });
      commandes.push({ id: commandeId, code, fournisseur_id: groupe.fournisseur_id });
    }

    const resultat = { commandes, idempotent_replay: false };
    await recordIdempotence(client, body.idempotency_key, "GENERATE", commandes[0]?.id ?? null, { commandes });
    await client.query("COMMIT");
    return resultat;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ----------------------------------- duplication ----------------------------------- */

export async function repoDuplicateAsDraft(
  id: string,
  note: string | undefined,
  audit: AuditContext
): Promise<{ id: string; code: string }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const sourceRes = await client.query(
      `SELECT * FROM public.commande_fournisseur WHERE id = $1::uuid`,
      [id]
    );
    const source = sourceRes.rows[0];
    if (!source) throw new HttpError(404, "COMMANDE_FOURNISSEUR_NOT_FOUND", "Commande fournisseur introuvable.");

    const fournisseur = await fetchFournisseurMini(client, source.fournisseur_id);
    assertFournisseurCommandable(fournisseur);

    const code = await generateCommandeFournisseurCode(client);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.commande_fournisseur (
          code, origine, fournisseur_id, contact_id, adresse_commande_id, magasin_livraison_id,
          adresse_livraison_texte, adresse_facturation_texte, devise, conditions_paiement, incoterm,
          mode_transport, date_besoin, commentaire_public, note_interne, frais_port_ht, tva_frais_pct,
          created_by, updated_by)
       SELECT $2, 'MANUEL', fournisseur_id, contact_id, adresse_commande_id, magasin_livraison_id,
              adresse_livraison_texte, adresse_facturation_texte, devise, conditions_paiement, incoterm,
              mode_transport, date_besoin, commentaire_public, $3, frais_port_ht, tva_frais_pct, $4, $4
         FROM public.commande_fournisseur WHERE id = $1::uuid
       RETURNING id`,
      [id, code, note ?? `Dupliquée depuis ${source.code}`, audit.user_id]
    );
    const newId = inserted.rows[0].id;

    // Copie des lignes ACTIVE — SANS les liens besoins (une couverture ne se duplique jamais).
    await client.query(
      `INSERT INTO public.commande_fournisseur_ligne (
          commande_id, position, type, article_id, catalogue_id, reference_fournisseur,
          designation, designation_interne, unite, unite_stock, coef_conversion,
          quantite, prix_unitaire_ht, remise_pct, tva_pct, frais_ht,
          date_besoin, date_promesse, delai_jours, affaire_id, commande_client_id, of_id,
          piece_technique_id, operation_libelle, magasin_id, exigences_qualite, documents_attendus,
          created_by, updated_by)
       SELECT $2::uuid, position, type, article_id, catalogue_id, reference_fournisseur,
              designation, designation_interne, unite, unite_stock, coef_conversion,
              quantite, prix_unitaire_ht, remise_pct, tva_pct, frais_ht,
              date_besoin, date_promesse, delai_jours, affaire_id, commande_client_id, of_id,
              piece_technique_id, operation_libelle, magasin_id, exigences_qualite, documents_attendus,
              $3, $3
         FROM public.commande_fournisseur_ligne
        WHERE commande_id = $1::uuid AND statut_ligne = 'ACTIVE'`,
      [id, newId, audit.user_id]
    );

    await recomputeTotauxTx(client, newId);
    await insertTransitionRow(client, newId, null, "BROUILLON", `Duplication de ${source.code}`, audit.user_id);
    await insertAuditLog(client, audit, {
      action: "commandes_fournisseurs.duplicate",
      entity_type: "commande_fournisseur",
      entity_id: newId,
      details: { source_id: id, source_code: source.code, code },
    });
    await client.query("COMMIT");
    return { id: newId, code };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
