# SOL-22 — Qualité, métrologie et traçabilité (backend)

- Date : 2026-08-14
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/450
- Branche : `feat/450-sol22-quality-intelligence`
- Base initiale : `origin/main` (`0a5baa77`)
- ADR : `docs/adr/ADR-0068-quality-intelligence-and-investigation.md`

## Diagnostic et cause racine

Les domaines Qualité, Métrologie et Traçabilité étaient solides séparément, mais
aucun contrat unique ne qualifiait FPY, PPM, délai de clôture ou coût de
non-qualité. Les causes restaient non structurées, les coûts n'avaient pas de
ledger dédié et le SPC n'avait pas de politique de fiabilité versionnée. Le graphe
de traçabilité existait, sans dataset d'enquête ni mesure explicite des liens
manquants. Pendant la recette réelle, deux défauts transverses ont aussi été
trouvés : double libération d'une connexion après transaction et élévation indue
par simple accès au module Qualité.

## Architecture et résultat

- calculs purs et explicables pour FPY, PPM, clôture, rebut, retouche et COPQ ;
- `null` et fiabilité visible lorsqu'un dénominateur, une catégorie de coût, une
  devise ou une preuve manque ;
- causes structurées, affectation optimiste/idempotente et audit immuable ;
- ledger de coûts append-only avec source, acteur, preuve et idempotence ;
- clôture CAPA bloquée quand une preuve obligatoire manque ;
- politiques SPC datées/versionnées, sous-groupes complets et cadence contrôlée ;
- centre métrologique existant réutilisé pour échéances et équipements bloquants ;
- enquête fondée sur le graphe canonique matière → livraison, avec couverture et
  liens manquants ; le temps métier reste indisponible faute d'événements source ;
- RBAC serveur : accès analytique réservé, opérateur refusé, override élevé explicite.

## Fichiers modifiés

- domaine, repository, service, contrôleur, validation, routes et middleware
  `src/module/qualite/` ;
- migration et supports `db/patches/20260814_sol22_quality_intelligence.sql` ;
- tests domaine, route, RBAC et gardes de migration dans `src/__tests__/` ;
- ADR-0068, runbook, index des patches et présent rapport.

## Migration et preuve de restauration

La migration est additive et n'insère que neuf familles de causes génériques. Elle
ne crée aucun coût ni politique SPC. Répétition PostgreSQL 16.14 jetable : 153
patchs appliqués, 0 en attente, 0 checksum divergent ; dump de 2 114 969 octets,
SHA-256 `13ace679cd197ccca0f86e7773c54f88d5edbf51f335b90a3648364450e67c89` ;
rollback `cerp_test` réussi, restauration dans `cerp_restore` réussie, 0 coût
orphelin et 0 cause invalide.

La preuve SQL déterministe a produit FPY 90 %, PPM 100 000, clôture 2 jours,
rebuts 100 EUR, retouches 50 EUR, COPQ 175 EUR, Pareto `MACHINE` et SPC v1 actif.
La concurrence de deux politiques actives a été refusée ; v1 a été retirée avec
acteur/motif, v2 activée, et toute réécriture de v1 a été rejetée. Le rejeu cause
a conservé le même `updated_at`; le rejeu coût le même UUID.

## Tests et vérification navigateur/E2E

| Contrôle | Résultat réel |
|---|---|
| tests SOL-22 ciblés | PASS — 4 fichiers, 19/19 |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| audit dépendances production | PASS — 0 vulnérabilité connue |
| parcours vente isolé après correctifs | PASS — 1/1, 35,7 s, 0 retry |
| parcours ERP isolés complets | PASS — 3/3, 59,0 s, 0 retry |
| suite backend complète | PASS — 298 fichiers, 4 588 réussis, 4 ignorés, 0 échec, 22,99 s |
| vérification navigateur | PASS — Centre Qualité sur `cerp_test`, drill-down actif, 0 erreur console |

Le parcours navigateur/API réel couvre vente → production → livraison → facture,
puis NC, cause rejouée, coût rejoué, enquête lot → BL, métriques et refus opérateur.
Les deux parcours achat complet et partiel passent aussi. Une première campagne
groupée avait échoué avant le flux métier parce que l'état vide expose deux CTA
« Nouvelle commande » : la recette cible maintenant l'unique CTA canonique déjà
marqué par l'application et vérifie son unicité. La campagne suivante passe 3/3.

La vérification manuelle instrumentée a confirmé dans le navigateur que FPY, PPM,
délai de clôture, rebuts, retouches et COPQ ne deviennent jamais zéro en l'absence
de preuve. Pareto et SPC restent explicitement indisponibles, et le drill-down du
Centre Qualité ouvre la page de traçabilité canonique.

Le preflight opérateur précédant l'application réelle a détecté que le patch
SOL-22 n'était pas encore inscrit dans la liste immuable du runner `--only`. Le
checksum LF canonique
`adf2b97867ef23f9c40ecd5df7c271cd40cc4d4d67c04cc60e7444f2cf367264`
est maintenant enregistré et couvert par le test du runner ; aucune base n'a été
écrite avant cette correction.

## Risques, compatibilité et travail restant

- les contrôles historiques sans source ou quantité rendent les ratios partiels ;
- le COPQ reste une borne inférieure tant que toutes les catégories ne sont pas
  alimentées ; aucune valeur manquante n'est interprétée comme zéro ;
- aucune politique SPC n'est inventée : le responsable Qualité doit renseigner
  échantillonnage, unité, cadence et volume réels ;
- le temps métier d'enquête nécessite de futurs événements début/clôture ; la
  durée technique de génération ne le remplace pas ;
- la clé `(source_type, source_id, category)` suppose que `source_id` identifie la
  preuve atomique du coût ; les intégrations futures doivent respecter ce contrat.

## Rollback

Redéployer d'abord l'ancien SHA en conservant les objets additifs. Le rollback SQL
n'est autorisé que sur `cerp_test` et sans donnée SOL-22 ; sinon restaurer le dump
pré-migration dans une nouvelle base après gel des écritures et vérifications. La
procédure exacte est dans le runbook associé.
