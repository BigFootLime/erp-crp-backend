// Reporting commercial 360 (#275) — fragments SQL partagés.
//
// Tout agrégat financier du CERP passe par ces fragments. Ils sont écrits une fois
// pour que le registre des factures, l'imputation des règlements et l'imputation des
// avoirs aient EXACTEMENT la même définition partout : c'est la condition pour que
// le total, la ventilation par client et le drill-down se réconcilient.
//
// Deux exigences non négociables sont câblées ici :
//   1. Reconstruction historique stricte : rien de postérieur à `as_of` n'entre.
//   2. Agrégation en NUMERIC, jamais en float8. Les sommes sortent en `text` et sont
//      converties une seule fois, à la frontière TypeScript (`money()`).

import {
  AVOIR_LEDGER_STATUSES,
  BL_SHIPPED_STATUSES,
  FACTURE_LEDGER_STATUSES,
  PAIEMENT_EXCLUDED_STATUSES,
  REPORTING_TIMEZONE,
  ledgerDateExpression,
  type DateBasis,
} from "../domain/reporting-policy";

/** Accumulateur de paramètres liés — aucune valeur n'est jamais interpolée dans le SQL. */
export class Params {
  readonly values: unknown[] = [];

  push(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * Convertit une somme NUMERIC renvoyée en `text` vers un nombre.
 * L'addition a déjà eu lieu en NUMERIC côté PostgreSQL : la conversion ne porte
 * que sur une valeur à deux décimales, exactement représentable ici.
 */
export function money(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Idem pour un ratio, qui peut légitimement être absent (dénominateur nul ou négatif). */
export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export function count(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Date d'une colonne `timestamptz` ramenée au calendrier français. */
export function parisDate(expression: string): string {
  return `(${expression} AT TIME ZONE '${REPORTING_TIMEZONE}')::date`;
}

// ---------------------------------------------------------------------------
// Registre des factures
// ---------------------------------------------------------------------------

export type LedgerOptions = {
  /** Date d'arrêté. Aucune pièce entrée après cette date n'est retenue. */
  asOf?: string;
  /** Bornes de période inclusives sur la date de registre. */
  from?: string;
  to?: string;
  basis: DateBasis;
  clientId?: string;
  currency?: string;
};

/**
 * CTE `ledger_facture` : les factures qui existent au registre commercial.
 *
 * Les statuts retenus sont ceux de `FACTURE_LEDGER_STATUSES` — canoniques #227 ET
 * héritage minuscule. Une facture en brouillon, en attente, approuvée ou annulée
 * n'y entre jamais : c'est le correctif du filtre `<> 'brouillon'` d'origine, qui
 * laissait passer `DRAFT`, `PENDING_VALIDATION`, `APPROVED` et `CANCELLED`.
 */
export function ledgerFactureCte(p: Params, opts: LedgerOptions): string {
  const dateExpr = ledgerDateExpression("f", opts.basis);
  const where: string[] = [`f.statut = ANY(${p.push([...FACTURE_LEDGER_STATUSES])}::text[])`];

  if (opts.asOf) where.push(`${dateExpr} <= ${p.push(opts.asOf)}::date`);
  if (opts.from) where.push(`${dateExpr} >= ${p.push(opts.from)}::date`);
  if (opts.to) where.push(`${dateExpr} <= ${p.push(opts.to)}::date`);
  if (opts.clientId) where.push(`f.client_id = ${p.push(opts.clientId)}`);
  if (opts.currency) where.push(`UPPER(COALESCE(f.currency, 'EUR')) = ${p.push(opts.currency)}`);

  return `
    ledger_facture AS (
      SELECT
        f.id,
        f.numero,
        f.client_id,
        UPPER(COALESCE(f.currency, 'EUR')) AS currency,
        f.total_ht::numeric(18,2)  AS total_ht,
        f.total_ttc::numeric(18,2) AS total_ttc,
        f.statut,
        f.date_emission,
        f.date_echeance,
        ${dateExpr} AS ledger_date,
        COALESCE(f.date_echeance, f.date_emission) AS due_date
      FROM facture f
      WHERE ${where.join("\n        AND ")}
    )`;
}

/** Idem pour les avoirs finalisés. Un avoir non finalisé ne diminue jamais le facturé. */
export function ledgerAvoirCte(p: Params, opts: LedgerOptions): string {
  const dateExpr = ledgerDateExpression("a", opts.basis);
  const where: string[] = [`a.statut = ANY(${p.push([...AVOIR_LEDGER_STATUSES])}::text[])`];

  if (opts.asOf) where.push(`${dateExpr} <= ${p.push(opts.asOf)}::date`);
  if (opts.from) where.push(`${dateExpr} >= ${p.push(opts.from)}::date`);
  if (opts.to) where.push(`${dateExpr} <= ${p.push(opts.to)}::date`);
  if (opts.clientId) where.push(`a.client_id = ${p.push(opts.clientId)}`);
  if (opts.currency) where.push(`UPPER(COALESCE(a.currency, 'EUR')) = ${p.push(opts.currency)}`);

  return `
    ledger_avoir AS (
      SELECT
        a.id,
        a.numero,
        a.client_id,
        a.facture_id,
        UPPER(COALESCE(a.currency, 'EUR')) AS currency,
        a.total_ht::numeric(18,2)  AS total_ht,
        a.total_ttc::numeric(18,2) AS total_ttc,
        a.statut,
        a.date_emission,
        ${dateExpr} AS ledger_date
      FROM avoir a
      WHERE ${where.join("\n        AND ")}
    )`;
}

// ---------------------------------------------------------------------------
// Règlements
// ---------------------------------------------------------------------------

/**
 * Prédicat « règlement net » : ni rejeté, ni extourné, ni contre-écriture d'extourne.
 * Neutre quelle que soit la convention d'extourne retenue plus tard.
 */
export function paiementNetPredicate(p: Params, alias = "p"): string {
  return `${alias}.status <> ALL(${p.push([...PAIEMENT_EXCLUDED_STATUSES])}::text[])
        AND ${alias}.workflow_status <> 'REVERSED'
        AND ${alias}.reversal_of_id IS NULL`;
}

/**
 * CTE `settled` : montants réellement imputés à chaque facture À LA DATE D'ARRÊTÉ.
 *
 * Deux sources, réunies sans double comptage :
 *   - `paiement_allocations` (lettrage #227), retenu si le règlement est encaissé
 *     ET l'imputation créée, tous deux au plus tard à `as_of` ;
 *   - le rattachement direct hérité `paiement.facture_id`, retenu uniquement pour
 *     les règlements qui n'ont AUCUNE ligne d'allocation (sinon on compterait deux fois).
 *
 * C'est ici que se joue la correction centrale de #275 : un règlement encaissé après
 * `as_of` ne doit pas modifier un encours passé.
 */
export function settledCte(p: Params, asOf: string): string {
  const asOfParam = p.push(asOf);
  const netAlloc = paiementNetPredicate(p, "p");
  const netLegacy = paiementNetPredicate(p, "p");
  return `
    settled AS (
      SELECT facture_id, SUM(amount)::numeric(18,2) AS amount
      FROM (
        SELECT pa.facture_id AS facture_id, pa.amount_ttc::numeric(18,2) AS amount
        FROM paiement_allocations pa
        JOIN paiement p ON p.id = pa.paiement_id
        WHERE p.date_paiement <= ${asOfParam}::date
          AND ${parisDate("pa.created_at")} <= ${asOfParam}::date
          AND ${netAlloc}

        UNION ALL

        SELECT p.facture_id AS facture_id, p.montant::numeric(18,2) AS amount
        FROM paiement p
        WHERE p.facture_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM paiement_allocations pa2 WHERE pa2.paiement_id = p.id)
          AND p.date_paiement <= ${asOfParam}::date
          AND ${netLegacy}
      ) s
      GROUP BY facture_id
    )`;
}

/**
 * CTE `credited` : avoirs finalisés réellement imputés à chaque facture à `as_of`.
 * Mêmes précautions que `settledCte` (allocations #227 + rattachement direct hérité).
 */
export function creditedCte(p: Params, asOf: string, basis: DateBasis): string {
  const asOfParam = p.push(asOf);
  const statuses = p.push([...AVOIR_LEDGER_STATUSES]);
  const dateExpr = ledgerDateExpression("a", basis);
  return `
    credited AS (
      SELECT facture_id, SUM(amount)::numeric(18,2) AS amount
      FROM (
        SELECT asa.facture_id AS facture_id, asa.amount_ttc::numeric(18,2) AS amount
        FROM avoir_source_allocations asa
        JOIN avoir a ON a.id = asa.avoir_id
        WHERE a.statut = ANY(${statuses}::text[])
          AND ${dateExpr} <= ${asOfParam}::date
          AND ${parisDate("asa.created_at")} <= ${asOfParam}::date
          AND asa.allocation_status <> 'REVERSED'

        UNION ALL

        SELECT a.facture_id AS facture_id, a.total_ttc::numeric(18,2) AS amount
        FROM avoir a
        WHERE a.facture_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM avoir_source_allocations asa2 WHERE asa2.avoir_id = a.id)
          AND a.statut = ANY(${statuses}::text[])
          AND ${dateExpr} <= ${asOfParam}::date
      ) c
      GROUP BY facture_id
    )`;
}

/**
 * CTE `balances` : solde signé de chaque facture du registre à `as_of`.
 *
 * Le solde N'EST PAS écrêté à zéro. Un solde négatif est un trop-perçu réel, qui doit
 * rester visible : `GREATEST(0, …)` le rendait invisible dans l'implémentation d'origine.
 */
export function balancesCte(): string {
  return `
    balances AS (
      SELECT
        lf.*,
        COALESCE(s.amount, 0)::numeric(18,2) AS settled_ttc,
        COALESCE(c.amount, 0)::numeric(18,2) AS credited_ttc,
        (lf.total_ttc - COALESCE(s.amount, 0) - COALESCE(c.amount, 0))::numeric(18,2) AS balance_ttc
      FROM ledger_facture lf
      LEFT JOIN settled  s ON s.facture_id = lf.id
      LEFT JOIN credited c ON c.facture_id = lf.id
    )`;
}

// ---------------------------------------------------------------------------
// Balance âgée
// ---------------------------------------------------------------------------

export const AGING_BUCKETS = [
  { key: "not_due", label: "Non échu", min: null as number | null, max: 0 },
  { key: "d1_30", label: "1 à 30 jours", min: 1, max: 30 },
  { key: "d31_60", label: "31 à 60 jours", min: 31, max: 60 },
  { key: "d61_90", label: "61 à 90 jours", min: 61, max: 90 },
  { key: "d90_plus", label: "Plus de 90 jours", min: 91, max: null as number | null },
] as const;

export type AgingBucketKey = (typeof AGING_BUCKETS)[number]["key"];

/**
 * Expression de tranche d'ancienneté. Les bornes sont disjointes et exhaustives :
 * toute créance ouverte tombe dans exactement une tranche, ce qui rend l'invariant
 * « somme des tranches = encours » vrai par construction.
 */
export function agingBucketExpression(asOfParam: string): string {
  return `CASE
        WHEN b.due_date IS NULL OR b.due_date >= ${asOfParam}::date THEN 'not_due'
        WHEN (${asOfParam}::date - b.due_date) BETWEEN 1 AND 30  THEN 'd1_30'
        WHEN (${asOfParam}::date - b.due_date) BETWEEN 31 AND 60 THEN 'd31_60'
        WHEN (${asOfParam}::date - b.due_date) BETWEEN 61 AND 90 THEN 'd61_90'
        ELSE 'd90_plus'
      END`;
}

// ---------------------------------------------------------------------------
// Chaîne commande → livraison
// ---------------------------------------------------------------------------

/** Valeur nette HT d'une quantité, au prix et à la remise de la ligne de commande. */
export function lineValueExpression(qty: string, alias = "cl"): string {
  return `(${qty} * COALESCE(${alias}.prix_unitaire_ht, 0) * (1 - COALESCE(${alias}.remise_ligne, 0) / 100.0))::numeric(18,2)`;
}

/**
 * CTE `shipped_lines` : quantités expédiées par ligne de commande à `as_of`.
 * Aligné sur `v_bon_livraison_reliquats_226` (seuls SHIPPED et DELIVERED consomment),
 * mais borné dans le temps, ce que la vue ne fait pas.
 */
export function shippedLinesCte(p: Params, asOf?: string): string {
  const statuses = p.push([...BL_SHIPPED_STATUSES]);
  const dateFilter = asOf
    ? `AND COALESCE(bl.date_expedition, bl.date_livraison, bl.date_creation) <= ${p.push(asOf)}::date`
    : "";
  return `
    shipped_lines AS (
      SELECT
        bll.commande_ligne_id,
        SUM(bll.quantite)::numeric(18,3) AS quantite_expediee
      FROM bon_livraison_ligne bll
      JOIN bon_livraison bl ON bl.id = bll.bon_livraison_id
      WHERE bll.commande_ligne_id IS NOT NULL
        AND bl.statut = ANY(${statuses}::text[])
        ${dateFilter}
      GROUP BY bll.commande_ligne_id
    )`;
}
