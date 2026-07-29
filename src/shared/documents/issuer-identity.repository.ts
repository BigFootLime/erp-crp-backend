import pool from "../../config/database"

import type { LegalParty } from "../pdf/legal-mentions"

/**
 * Lecture de l'identite de l'entite emettrice et de ses mentions legales en vigueur.
 *
 * **Un seul point d'entree pour tous les documents sortants** — facture, avoir, bon de
 * livraison, pack COFC, accuse de reception. Chaque module reconstruisait auparavant sa
 * propre idee de l'emetteur : `livraisons` lisait `biller_name` seul, `facturation` lisait
 * une liste blanche de colonnes qui **n'existent pas** dans `factureur`. Les documents
 * divergeaient donc sur l'identite de celui qui les emet.
 *
 * ## Le contrat de date
 *
 * `fn_finance_issuer_snapshot(biller_id, date)` resout les mentions **en vigueur a la date
 * demandee**. Cette date n'est pas « aujourd'hui » : c'est la date d'emission du document.
 * Une facture emise en janvier doit porter les mentions de janvier, meme regeneree — sauf
 * qu'une facture emise ne se regenere jamais, precisement parce que son instantane est fige.
 *
 * ## Tolerance a l'absence de patch
 *
 * Tant que `20260729_finance_legal_mentions.sql` n'est pas applique, la fonction n'existe
 * pas (SQLSTATE `42883`) : on retombe alors sur l'identite operationnelle seule plutot que
 * de faire echouer la generation. Un document sans mentions reste un document ; une
 * generation qui leve laisse l'utilisateur sans rien.
 */

/** Code SQLSTATE : fonction inexistante. */
const UNDEFINED_FUNCTION = "42883"
/** Code SQLSTATE : table inexistante. */
const UNDEFINED_TABLE = "42P01"

function isMissingObject(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return code === UNDEFINED_FUNCTION || code === UNDEFINED_TABLE
}

/** Identite operationnelle seule, quand la table de mentions n'est pas encore en place. */
async function fallbackIssuerParty(billerId: string | null): Promise<LegalParty> {
  const result = await pool.query<{ party: LegalParty }>(
    `
      SELECT jsonb_strip_nulls(jsonb_build_object(
        'biller_id',      f.biller_id,
        'company_name',   f.biller_name,
        'address_line_1', NULLIF(btrim(concat_ws(' ', f.house_number, f.street)), ''),
        'postal_code',    f.postal_code,
        'city',           f.city,
        'country',        f.country,
        'phone',          f.phone,
        'email',          f.email,
        'bank_name',      f.default_bank_name,
        'iban',           f.default_iban,
        'bic',            f.default_bic
      )) AS party
      FROM public.factureur f
      WHERE ($1::uuid IS NULL OR f.biller_id = $1::uuid)
      ORDER BY f.biller_id ASC
      LIMIT 1
    `,
    [billerId]
  )
  return result.rows[0]?.party ?? {}
}

/**
 * Instantane complet de l'emetteur a une date donnee.
 *
 * `billerId` a `null` prend le premier emetteur enregistre : c'est le comportement
 * historique de `getIssuerParty()` et `getCompanyHeader()`, conserve tant que le
 * referentiel ne porte qu'une entite. La politique Finance, elle, designe explicitement son
 * entite legale et doit passer son identifiant.
 *
 * Renvoie `{}` quand aucun emetteur n'est configure. Le rendu affiche alors « Non
 * renseigne » plutot que d'inventer une identite.
 */
export async function readIssuerParty(options: { billerId?: string | null; at?: string | null } = {}): Promise<LegalParty> {
  const billerId = options.billerId ?? null
  // La date d'emission gouverne la version de mentions ; a defaut, la date du jour.
  const at = options.at ? String(options.at).slice(0, 10) : null

  try {
    const result = await pool.query<{ party: LegalParty | null }>(
      `
        SELECT public.fn_finance_issuer_snapshot(f.biller_id, COALESCE($2::date, CURRENT_DATE)) AS party
        FROM public.factureur f
        WHERE ($1::uuid IS NULL OR f.biller_id = $1::uuid)
        ORDER BY f.biller_id ASC
        LIMIT 1
      `,
      [billerId, at]
    )
    return result.rows[0]?.party ?? {}
  } catch (error) {
    if (!isMissingObject(error)) throw error
    return fallbackIssuerParty(billerId)
  }
}
