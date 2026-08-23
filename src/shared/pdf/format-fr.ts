/**
 * Mise en forme francaise des nombres, taux et dates pour les documents sortants.
 *
 * Extrait de `facturation/services/finance-document-render.ts` (#216) pour etre partage :
 * les mentions legales de l'emetteur portent un capital social et des taux, et elles
 * s'impriment aussi sur le bon de livraison et l'accuse de reception, qui ne peuvent pas
 * dependre du module facturation.
 *
 * Monetary values are canonicalised to two decimal places at the rendering
 * boundary. Database numerics arrive as strings, but legacy float paths can
 * otherwise leak tails such as `6172.799999999999` into a legal document.
 */

/** Date ISO en date francaise : `22/07/2026`. */
export function formatDateFR(iso: string | null | undefined): string {
  if (!iso) return "-"
  const raw = String(iso)
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`
  return raw
}

/** Pourcentage a la francaise : `20,00 %`. Meme regle que `money` — aucun chiffre change. */
export function percent(value: string): string {
  const raw = String(value ?? "").trim()
  if (!/^-?\d+(?:[.,]\d+)?$/.test(raw)) return `${raw} %`.trim()
  return `${raw.replace(".", ",")} %`
}

/**
 * Montant au format francais : `10 465,20 €`.
 *
 * Le referentiel fournit des chaines a point decimal (`10465.20`) et le document les sortait
 * telles quelles, avec le code ISO — sur une facture francaise, et alors que les documents
 * rendus dans le navigateur affichent deja `10 465,20 €` pour la meme entreprise.
 *
 * Une chaine qui n'est pas un nombre est rejetee : un montant ambigu ne doit
 * jamais atteindre un PDF archive.
 */
export function money(amount: string | number, currency: string): string {
  const raw = String(amount ?? "").trim()
  const symbol = currency === "EUR" ? "€" : currency

  const match = raw.match(/^(-?)(\d+)(?:[.,](\d+))?$/)
  if (!match) throw new Error("PDF_MONEY_INVALID")

  const [, sign, whole, decimalPart = ""] = match
  // Work in cents with BigInt so a 15+ digit ERP amount and a JS float tail
  // are rounded deterministically without introducing another IEEE-754 error.
  let cents = BigInt(whole) * 100n + BigInt(decimalPart.slice(0, 2).padEnd(2, "0"))
  if (decimalPart.length > 2 && decimalPart[2] >= "5") cents += 1n
  const integer = (cents / 100n).toString()
  const decimals = (cents % 100n).toString().padStart(2, "0")
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return `${sign}${grouped},${decimals} ${symbol}`
}

/**
 * Taux debarrasse de ses zeros decimaux inutiles : `12.500` devient `12,5 %`.
 *
 * Un taux de penalite s'ecrit `12,5 %`, pas `12,500 %` : la precision de stockage
 * (numeric(6,3)) n'a pas a transparaitre sur une mention legale.
 */
export function rate(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim()
  if (!/^-?\d+(?:[.,]\d+)?$/.test(raw)) return raw ? percent(raw) : null
  const trimmed = raw.replace(",", ".").replace(/\.(\d*?)0+$/, ".$1").replace(/\.$/, "")
  return percent(trimmed)
}
