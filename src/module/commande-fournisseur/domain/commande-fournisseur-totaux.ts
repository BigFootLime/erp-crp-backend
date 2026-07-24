/**
 * Calcul serveur des totaux d'une commande fournisseur (#172).
 *
 * Règles d'arrondi (documentées + testées) :
 *  - tout calcul passe par des centimes entiers (pas d'accumulation flottante) ;
 *  - arrondi « half away from zero » (comme round() PostgreSQL), au niveau de CHAQUE
 *    agrégat de ligne (net HT, remise, TVA), puis sommation exacte des centimes ;
 *  - les frais de port s'ajoutent au total HT et portent leur propre taux de TVA.
 *
 * Le frontend n'est jamais autoritaire : il affiche ces montants, il ne les recalcule pas
 * pour décider.
 */

export type LigneTotauxInput = {
  quantite: number;
  prix_unitaire_ht: number;
  remise_pct: number;
  tva_pct: number;
  frais_ht: number;
  statut_ligne?: "ACTIVE" | "ANNULEE";
};

export type LigneTotaux = {
  brut_ht: number;
  remise_montant: number;
  net_ht: number;
  tva_montant: number;
  ttc: number;
};

export type CommandeTotaux = {
  total_ht: number;
  total_remise: number;
  total_tva: number;
  total_ttc: number;
  frais_port_ht: number;
};

/**
 * Arrondi « half away from zero » à 2 décimales. Le passage par `toFixed(6)` neutralise le
 * bruit binaire IEEE 754 (ex. 2.675*100 = 267.49999999999997) bien en dessous du 1e-6,
 * puis l'arrondi entier s'applique sur des centimes exacts.
 */
export function roundMoney(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const cents = Math.round(Number((Math.abs(value) * 100).toFixed(6)));
  return (sign * cents) / 100;
}

function toCents(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Number((Math.abs(value) * 100).toFixed(6)));
}

export function computeLigneTotaux(ligne: LigneTotauxInput): LigneTotaux {
  const brut = ligne.quantite * ligne.prix_unitaire_ht;
  const remise = brut * (ligne.remise_pct / 100);
  const brutR = roundMoney(brut);
  const remiseR = roundMoney(remise);
  const netR = roundMoney(brutR - remiseR + ligne.frais_ht);
  const tvaR = roundMoney(netR * (ligne.tva_pct / 100));
  return {
    brut_ht: brutR,
    remise_montant: remiseR,
    net_ht: netR,
    tva_montant: tvaR,
    ttc: roundMoney(netR + tvaR),
  };
}

export function computeCommandeTotaux(
  lignes: readonly LigneTotauxInput[],
  options: { frais_port_ht: number; tva_frais_pct: number }
): CommandeTotaux {
  let htCents = 0;
  let remiseCents = 0;
  let tvaCents = 0;

  for (const ligne of lignes) {
    if (ligne.statut_ligne === "ANNULEE") continue;
    const t = computeLigneTotaux(ligne);
    htCents += toCents(t.net_ht);
    remiseCents += toCents(t.remise_montant);
    tvaCents += toCents(t.tva_montant);
  }

  const fraisPort = roundMoney(options.frais_port_ht);
  const tvaFrais = roundMoney(fraisPort * (options.tva_frais_pct / 100));
  htCents += toCents(fraisPort);
  tvaCents += toCents(tvaFrais);

  const total_ht = htCents / 100;
  const total_tva = tvaCents / 100;
  return {
    total_ht,
    total_remise: remiseCents / 100,
    total_tva,
    total_ttc: (htCents + tvaCents) / 100,
    frais_port_ht: fraisPort,
  };
}
