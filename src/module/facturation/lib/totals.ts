type LineLike = {
  quantite: number;
  prix_unitaire_ht: number;
  remise_ligne?: number | null | undefined;
  taux_tva?: number | null | undefined;
};

export type LineTotals = {
  total_ht: number;
  total_tva: number;
  total_ttc: number;
};

export type DocumentTotals = {
  subtotal_ht: number;
  subtotal_ttc: number;
  remise_pct: number;
  total_ht: number;
  total_tva: number;
  total_ttc: number;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function computeLineTotals(line: LineLike): LineTotals {
  const qte = Number.isFinite(line.quantite) ? line.quantite : 0;
  const pu = Number.isFinite(line.prix_unitaire_ht) ? line.prix_unitaire_ht : 0;
  const remise = clamp(Number(line.remise_ligne ?? 0), 0, 100);
  const tva = clamp(Number(line.taux_tva ?? 0), 0, 100);

  const baseHt = qte * pu * (1 - remise / 100);
  const total_ht = round2(Math.max(0, baseHt));
  const total_ttc = round2(total_ht * (1 + tva / 100));
  const total_tva = round2(total_ttc - total_ht);
  return { total_ht, total_tva, total_ttc };
}

export function computeDocumentTotals(lines: readonly LineLike[], remise_globale_pct: number): DocumentTotals {
  const safeLines = Array.isArray(lines) ? lines : [];
  const subtotal_ht = round2(safeLines.reduce((s, l) => s + computeLineTotals(l).total_ht, 0));
  const subtotal_ttc = round2(safeLines.reduce((s, l) => s + computeLineTotals(l).total_ttc, 0));
  const remise_pct = clamp(Number(remise_globale_pct || 0), 0, 100);

  const total_ht = round2(subtotal_ht * (1 - remise_pct / 100));
  const total_ttc = round2(subtotal_ttc * (1 - remise_pct / 100));
  const total_tva = round2(total_ttc - total_ht);

  return { subtotal_ht, subtotal_ttc, remise_pct, total_ht, total_tva, total_ttc };
}
