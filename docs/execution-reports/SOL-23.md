# SOL-23 — Livraisons, facturation, ADV et marge (backend)

- Date : 2026-08-14
- Propriétaire : Keenan Martin
- Issue : [#455](https://github.com/BigFootLime/erp-crp-backend/issues/455)
- Branche : `feature/455-sol23-adv-cash-margin`
- Base initiale : `origin/main` (`d07022df94f85bd131798b587c8dba444b0acdc7`)
- ADR : `docs/adr/ADR-0069-adv-otif-cash-boundary.md`

## Diagnostic et cause racine

Les objets de livraison, facture, échéance, paiement, avoir, affaire et OF
existaient, mais sans frontière ADV unique. L'OTIF était recalculable depuis
l'état courant, donc réécrivable de fait ; les blocages de livraison, promesses
de paiement et litiges n'avaient ni dossier audité ni commande idempotente ; le
cash attendu pouvait être double compté entre promesse et échéancier. La marge
SOL-13 n'était pas reliée à la chronologie commande → livraison → facture.

La première recette Playwright réelle a en outre découvert SQLSTATE `42P18` : la
file de livraison transmettait des paramètres inutilisés avant les paramètres
référencés. PostgreSQL ne pouvait pas typer `$1`. La numérotation a été corrigée
à la source ; aucun timeout, mock ou fallback n'a été ajouté.

Le preflight opérateur réel a ensuite démontré un second défaut avant écriture :
le patch était couvert par la répétition SOL-06 mais absent du registre immuable
`--only` du runner d'exploitation. Son SHA-256 LF canonique
`f14a8d356312133841168e681f4266142ff95f7e4a07dc6c2a18dd50b9a4f52e`
est désormais enregistré et testé. Le runner avait bien refusé les deux bases
avant toute mutation.

## Choix d'architecture

- le ledger Finance existant reste l'autorité pour factures partielles, avoirs,
  échéances et allocations de paiements ; SOL-23 ne le duplique pas ;
- l'OTIF est figé à la première complétude d'une commande par preuve append-only ;
  les commandes historiques encore dérivées de l'état courant sont marquées
  `PARTIAL`, jamais présentées comme preuve constatée ;
- DSO par devise = encours TTC / TTC émis sur 365 jours × 365, en centimes exacts ;
- le cash à 30 jours consomme d'abord les promesses puis seulement l'échéancier
  résiduel, le tout plafonné au solde de la facture ;
- catégories de blocage : qualité, document, stock et transport ; dossiers à
  transition unique, contrôle de concurrence, idempotence et audit ;
- préparation e-facture strictement interne : `NOT_ASSESSED`, `BLOCKED` ou
  `READY_FOR_CONNECTOR`. Aucun statut transport/réglementaire n'est inventé ;
- drill-down vers les snapshots de marge SOL-13 par devis, affaire et OF.

## Fichiers modifiés

- module `src/module/adv-reliability/` : domaine, validation, repository,
  contrôleurs, routes et tests numériques ;
- montage sous `src/module/facturation/routes/reporting.routes.ts` ;
- patch `db/patches/20260814_adv_reliability_sol23.sql` et scripts de support ;
- garde de migration, tests route/RBAC et documentation HTTP ;
- ADR-0069 et présent rapport.

## Migration, données et rollback

Le patch est additif : six tables ADV, index, contraintes, journal append-only,
reçus idempotents et trigger de gel OTIF. Il ne crée aucune promesse, aucun
litige, aucun blocage, aucun taux et aucun montant métier. Les propriétaires et
droits sont bornés au rôle applicatif existant.

Répétition PostgreSQL 16 jetable : **154 appliqués, 0 en attente, 0 checksum
divergent**. Sauvegarde, rollback SQL contrôlé, restauration vers une base neuve,
rejeu et contrôles d'orphelins ont réussi. En production, le retour arrière sûr
consiste à redéployer l'ancien SHA en conservant les objets additifs. Si un retour
de schéma devient obligatoire après création de preuves, geler les écritures et
restaurer le dump pré-migration dans une base neuve ; ne pas exécuter les `DROP`
du script test sur `cerp_prod`.

## Tests exécutés

| Contrôle | Résultat réel |
|---|---|
| tests SOL-23 ciblés | PASS — 3 fichiers, 13/13 |
| typecheck backend | PASS |
| suite backend complète | PASS — 0 échec |
| build backend + frontière données production | PASS — 673 fichiers runtime |
| audit dépendances production | PASS — 0 vulnérabilité connue |
| répétition migration SOL-06 | PASS — sauvegarde, rollback, restauration et rejeu |
| E2E isolé ADV Chromium | PASS — 1/1 en 3,9 s, sans retry |

L'E2E a réellement démarré PostgreSQL, appliqué 154 migrations, chargé le seed
déterministe, construit frontend/backend, authentifié un rôle autorisé, appelé
l'API et affiché l'onglet ADV. Les traces, captures et vidéos restent limitées
aux échecs dans `test-results/sol-05/`.

## Permissions, audit et compatibilité

- lecture : capacité serveur `reporting_financial` ;
- blocages livraison : `draft_write` ; promesses : `payment_register` ; litiges :
  `credit_write` ; les refus anonymes et rôle insuffisant sont testés ;
- chaque mutation exige `Idempotency-Key`, verrouille l'objet métier, vérifie la
  version lors d'une clôture et écrit événement + audit dans la transaction ;
- le contrat est `CERP-ADV-1.0.0`, privé et `no-store` ;
- aucune isolation société/site supplémentaire n'existe dans le schéma actuel ;
  le module suit donc la frontière d'autorisation globale existante et ne prétend
  pas fournir une segmentation absente.

## Risques et éléments restant réellement à faire

- l'OTIF antérieur au déploiement reste `PARTIAL` tant qu'aucune preuve figée
  n'existe ; aucun backfill spéculatif n'est effectué ;
- les factures sans date d'échéance sont classées `UNKNOWN`, pas zéro jour ;
- le cash reste `PARTIAL` car une promesse est une déclaration, non un paiement ;
- le connecteur de facturation électronique reste volontairement indisponible
  jusqu'au choix et à la qualification d'un fournisseur réel ;
- les migrations réelles, promotions et déploiements sont consignés dans la
  mise à jour finale de ce rapport après vérification des SHA distants.

## Traçabilité de pilotage

Le dry-run Project Office a refusé l'appel avant toute écriture car
`CERP_PROJECT_OFFICE_URL` n'est pas configurée comme URL HTTP(S). L'issue GitHub
#455 constitue donc la trace canonique de cette exécution.
