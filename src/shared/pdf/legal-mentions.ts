import { money, rate } from "./format-fr"

/**
 * Mentions legales de l'entite emettrice, communes a **tous** les documents sortants.
 *
 * Ce module ne vit pas dans `module/facturation` a dessein : les memes mentions doivent
 * figurer sur la facture, l'avoir, le bon de livraison, le pack COFC et l'accuse de
 * reception. Une seule redaction, un seul endroit — sinon les documents divergent, ce qui
 * est exactement le defaut que #213 et #216 ont corrige pour la mise en page.
 *
 * ## Ce que le referentiel ne portait pas
 *
 * `public.factureur` est une table historique : elle ne possede **aucune** colonne legale
 * (ni SIRET, ni SIREN, ni RCS, ni numero de TVA, ni capital, ni forme juridique) et elle
 * etait vide sur `cerp_test` comme sur `cerp_prod`. Le rendu etait donc pret a afficher des
 * mentions qui n'existaient nulle part. Le patch `20260729_finance_legal_mentions.sql`
 * cree la table versionnee `finance_legal_mentions` et la fonction de resolution
 * `fn_finance_issuer_snapshot(biller_id, date)`.
 *
 * ## Pourquoi une lecture defensive
 *
 * L'instantane est libre de forme et **immuable** : un document emis il y a deux ans porte
 * la forme d'instantane de l'epoque. On lit donc plusieurs cles possibles et **on n'affiche
 * que ce qui existe reellement**. Une mention absente n'est jamais remplacee par un
 * substitut, un tiret ou une etiquette vide : sur une piece fiscale, une mention inventee
 * est pire qu'une mention manquante.
 */

/** Instantane d'une partie, tel que fige dans le document. Forme libre, volontairement. */
export type LegalParty = Record<string, unknown>

function clean(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : ""
  return s ? s : null
}

/** Premiere valeur non vide parmi plusieurs cles possibles. */
export function pickMention(source: LegalParty, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = clean(source[key])
    if (value) return value
  }
  return null
}

function flag(source: LegalParty, key: string): boolean {
  return source[key] === true || source[key] === "true"
}

/** Une version de mentions a-t-elle ete resolue pour ce document ? */
function hasMentionSet(party: LegalParty): boolean {
  return pickMention(party, "legal_mentions_version") !== null
}

/**
 * Capital social mis en forme, avec sa devise.
 *
 * Stocke en `numeric(14,2)` et transporte en texte : le rendu met en forme, il ne calcule
 * pas. `21000.00` devient `21 000,00 €`.
 */
export function shareCapital(party: LegalParty): string | null {
  const amount = pickMention(party, "share_capital", "capital_social")
  if (!amount) return null
  const currency = pickMention(party, "share_capital_currency") ?? "EUR"
  return money(amount, currency)
}

/**
 * Ligne d'identite legale, portee par **toutes les pages** de **tous** les documents.
 *
 * C'est la disposition de la facture papier de l'entreprise : le bloc « Emetteur » en tete
 * porte l'adresse et le telephone, le pied porte capital, RCS, SIRET et numero de TVA. La
 * repeter a chaque page garantit qu'une page detachee reste rattachable a son emetteur.
 *
 * Mentions couvertes : art. R123-237 du code de commerce (forme juridique, capital, RCS et
 * ville d'immatriculation, SIREN/SIRET) et art. 242 nonies A de l'annexe II au CGI
 * (numero de TVA intracommunautaire).
 */
export function issuerIdentityLine(party: LegalParty): string | null {
  const form = pickMention(party, "legal_form", "forme_juridique")
  const capital = shareCapital(party)
  const rcsNumber = pickMention(party, "rcs_number", "rcs")
  const rcsCity = pickMention(party, "rcs_city")
  const siret = pickMention(party, "siret")
  const siren = pickMention(party, "siren")
  const vat = pickMention(party, "vat_number", "numero_tva", "tva_intracommunautaire")
  const ape = pickMention(party, "ape_code", "code_ape", "naf")

  const identity =
    form && capital ? `${form} au capital de ${capital}` : form ? form : capital ? `Capital social ${capital}` : null

  // « RCS <ville> <numero> » : sans la ville, la mention est incomplete au regard de
  // R123-237 — c'est precisement ce qui manquait sur la facture papier.
  const rcs = rcsNumber ? (rcsCity ? `RCS ${rcsCity} ${rcsNumber}` : `RCS ${rcsNumber}`) : null

  const segments = [
    identity,
    rcs,
    siret ? `SIRET ${siret}` : siren ? `SIREN ${siren}` : null,
    vat ? `TVA ${vat}` : null,
    ape ? `APE ${ape}` : null,
  ].filter((segment): segment is string => Boolean(segment))

  return segments.length ? segments.join(" · ") : null
}

/** `12.500` + `ANNUEL` devient `12,5 % l'an`. */
function rateWithBasis(value: string | null, basis: string | null): string | null {
  const formatted = rate(value)
  if (!formatted) return null
  const normalized = (basis ?? "").toUpperCase()
  if (normalized === "MENSUEL") return `${formatted} par mois`
  if (normalized === "ANNUEL") return `${formatted} l'an`
  return formatted
}

/**
 * Mentions de reglement et clauses, en fin de document.
 *
 * Chaque entree est un paragraphe autonome. L'ordre suit celui du code de commerce :
 * penalites, indemnite forfaitaire, escompte, puis regime de TVA et clauses.
 *
 * Rien n'est emis sans donnee correspondante, a une exception assumee : **l'escompte est
 * une mention obligatoire meme en son absence** (art. L441-9). Quand une version de
 * mentions est resolue mais qu'aucun taux n'est parametre, le document ecrit donc
 * explicitement qu'aucun escompte n'est accorde. Si aucune version n'est resolue, on
 * n'ecrit rien : on ne sait pas, et on ne le devine pas.
 */
export function issuerLegalMentions(party: LegalParty): string[] {
  const mentions: string[] = []

  // 1. Penalites de retard — art. L441-10 du code de commerce.
  const penalty = rateWithBasis(
    pickMention(party, "late_penalty_rate", "taux_penalites_retard"),
    pickMention(party, "late_penalty_basis")
  )
  if (penalty) {
    mentions.push(
      `Pénalités de retard : ${penalty}, exigibles de plein droit le jour suivant la date de règlement, ` +
        `sans rappel préalable (art. L441-10 du code de commerce).`
    )
  }

  // 2. Indemnite forfaitaire de recouvrement — art. D441-5, 40 € depuis le decret 2012-1115.
  const indemnity = pickMention(party, "recovery_indemnity", "indemnite_recouvrement")
  if (indemnity) {
    mentions.push(
      `Indemnité forfaitaire pour frais de recouvrement : ${money(indemnity, "EUR")} par facture ` +
        `(art. D441-5 du code de commerce), sans préjudice d'une indemnisation complémentaire sur justificatifs.`
    )
  }

  // 3. Escompte — obligatoire meme en son absence.
  const discount = rateWithBasis(
    pickMention(party, "early_discount_rate", "taux_escompte"),
    pickMention(party, "early_discount_basis")
  )
  if (discount) {
    mentions.push(`Escompte pour paiement anticipé : ${discount}.`)
  } else if (hasMentionSet(party)) {
    mentions.push(`Escompte pour paiement anticipé : aucun escompte n'est accordé.`)
  }

  // 4. Regimes de TVA.
  if (flag(party, "vat_exempt_293b")) {
    mentions.push(`TVA non applicable, article 293 B du code général des impôts.`)
  }
  if (flag(party, "vat_on_receipts")) {
    mentions.push(`TVA acquittée sur les encaissements.`)
  }

  // 5. Reserve de propriete — loi du 12 mai 1980, reprise telle qu'elle est parametree.
  const retention = pickMention(party, "retention_of_title", "reserve_propriete")
  if (retention) {
    mentions.push(`Réserve de propriété : ${retention}`)
  }

  // 6. Mentions libres additionnelles, dans l'ordre du parametrage.
  const extras = party.extra_mentions
  if (Array.isArray(extras)) {
    for (const extra of extras) {
      const text = clean(extra)
      if (text) mentions.push(text)
    }
  }

  return mentions
}

/**
 * Coordonnees de reglement, quand elles sont parametrees.
 *
 * Ce n'est pas une mention obligatoire, mais c'est ce que porte la facture papier de
 * l'entreprise et c'est ce qui permet au client de payer.
 */
export function issuerPaymentDetails(party: LegalParty): string | null {
  const iban = pickMention(party, "iban", "default_iban")
  if (!iban) return null
  const bic = pickMention(party, "bic", "default_bic")
  const bank = pickMention(party, "bank_name", "default_bank_name")
  return [`RIB : ${iban}`, bic ? `BIC : ${bic}` : null, bank].filter(Boolean).join(" · ")
}
