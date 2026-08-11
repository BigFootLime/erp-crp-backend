# Audit des usages « marge » — SOL-13

Date : 2026-08-11
Périmètre : `erp-crp-backend` et `crp-systems-web`

## Verdict

Le seul calcul financier publiable est `CERP-MARGIN-2.0.0`, servi par `/api/v1/margins`. Il distingue `QUOTED`, `STANDARD`, `UPDATED` et `ACTUAL`; chaque résultat porte définition, unité, période, fraîcheur, fiabilité, formule et preuves. Une entrée absente laisse coût et marge à `null`.

## Usages décisionnels

| Consommateur | Décision SOL-13 | Statut |
|---|---|---|
| `src/module/margin-engine/**` | Moteur autoritaire, quatre perspectives, waterfall et drill-down serveur | Branché |
| `src/modules/devis/components/DevisRentabiliteTab.tsx` | Consomme exclusivement le moteur; aucun calcul React | Branché |
| `src/modules/margin/components/margin-ledger.tsx` | Affiche fiabilité, période, fraîcheur, formule, sources et absences | Branché |
| `src/modules/margin/components/margin-lines-table.tsx` | Interroge chaque ligne et affiche les écarts fournis par le serveur | Branché |
| `src/modules/pieces-technique/pages/PieceTechniqueViewPage.tsx` | Ancienne « marge théorique » locale supprimée; redirection vers un devis/OF | Indisponible explicite |
| `src/module/facturation/services/reporting-v2.service.ts` | `MARGIN_UNAVAILABLE`; aucune agrégation client approximative | Indisponible explicite |
| `src/module/facturation/domain/reporting-policy.ts` | Explique que l'allocation multi-objets, avoirs, retours et frais indirects n'est pas réconciliée | Différé honnêtement |

## Faux positifs exclus

Les occurrences `margin` des générateurs PDF, e-mails HTML et géométrie de document désignent des marges de mise en page. Le mot-clé `marge` du poste opérateur relève de la recherche textuelle. Ils ne calculent ni ne publient une marge financière.

## Sources de coût

| Poste | Source actuelle | Règle d'absence |
|---|---|---|
| Prix/devis | devis et lignes, HT après remises | `null` si le périmètre n'existe pas |
| Matière réelle | sorties stock `POSTED` liées à une réservation d'OF `CONSUMED`, valorisées au CUMP | coût unitaire absent = entrée manquante |
| Temps prévu/réel | opérations d'OF et taux versionnés applicables à la date | heures ou taux absents = entrée manquante |
| Sous-traitance | réception fournisseur × prix remisé + frais proratisés | réception ou prix absent = entrée manquante |
| Rebuts/retouches | déclarations de production append-only | quantité positive non valorisée = entrée manquante |
| Outillage, emballage, transport, frais indirects | entrée versionnée ou taux versionné | jamais de zéro implicite; `NOT_APPLICABLE` doit être explicite |

## Limites assumées

- La marge client consolidée reste indisponible jusqu'à la réconciliation exhaustive facture ↔ objet de marge.
- Une quantité positive de rebut/retouche n'est pas monétisée arbitrairement : elle bloque la marge complète jusqu'à sa valorisation.
- Les preuves `PLANNED` historiques restent lisibles comme repli standard hérité, mais aucune nouvelle écriture ne peut utiliser cette base ambiguë.
