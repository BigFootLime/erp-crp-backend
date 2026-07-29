/**
 * Nommage automatique des gammes — issue #227.
 *
 * POURQUOI
 * Le contrat exigeait `nom` à la création, donc l'écran demandait à l'opérateur d'inventer
 * un intitulé (« Gamme série », « Gamme prototype »…). Résultat : deux ateliers nomment
 * différemment la même chose, et le nom cesse d'être une donnée exploitable. Le nom d'une
 * gamme est une CONSÉQUENCE de la pièce et de son indice, pas une opinion : le serveur le
 * calcule.
 *
 * Domaine pur et déterministe : mêmes entrées ⇒ même nom, ce qui rend le rejeu et les
 * tests possibles sans base.
 */

export type GammeNamingInput = {
  /** Code métier de la pièce (ex. « 045-10233-000 »). */
  codePiece?: string | null;
  /** Désignation de la pièce, utilisée seulement si le code manque. */
  designation?: string | null;
  /** Indice de la version portant la gamme (ex. « A »). */
  indice?: string | null;
  /**
   * Rang de la gamme sur cet indice, 1 pour la première. Au-delà, le rang est suffixé :
   * plusieurs gammes peuvent coexister sur un même indice (série vs prototype).
   */
  rank?: number | null;
};

const MAX_LENGTH = 200; // borne de la colonne public.gammes.nom

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/**
 * Construit le nom canonique d'une gamme.
 *
 *   « Gamme 045-10233-000 — indice A »
 *   « Gamme 045-10233-000 — indice A (2) »   (deuxième gamme du même indice)
 *   « Gamme Carter aluminium — indice A »    (repli quand le code manque)
 *   « Gamme — indice A »                     (repli ultime : l'indice suffit à situer)
 */
export function buildGammeName(input: GammeNamingInput): string {
  const subject = clean(input.codePiece) || clean(input.designation);
  const indice = clean(input.indice);
  const rank = typeof input.rank === "number" && Number.isFinite(input.rank) ? Math.trunc(input.rank) : 1;

  const head = subject ? `Gamme ${subject}` : "Gamme";
  const withIndice = indice ? `${head} — indice ${indice}` : head;
  const named = rank > 1 ? `${withIndice} (${rank})` : withIndice;

  return named.length > MAX_LENGTH ? `${named.slice(0, MAX_LENGTH - 1)}…` : named;
}

/**
 * Nom effectif d'une gamme : un intitulé explicitement fourni est respecté (reprise de
 * données, import, renommage volontaire), sinon le serveur nomme. L'UI de création
 * n'envoie plus rien — c'est le point de la correction.
 */
export function resolveGammeName(provided: string | null | undefined, input: GammeNamingInput): string {
  const explicit = clean(provided);
  return explicit || buildGammeName(input);
}
