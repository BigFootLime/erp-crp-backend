# SOL-18 — Fournisseurs, achats et réceptions (backend)

- Date : 2026-08-12
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/431
- Branche de travail : feature/431-sol18-procurement-scorecard
- Base : origin/dev 6891114fdd6232972c3eaad83a50b4b26d4460b0
- ADR : docs/adr/ADR-0064-procurement-reliability-boundary.md

## Diagnostic et cause racine

Les commandes, réceptions, contrôles entrants, lots et documents existaient mais
étaient consultés séparément. Les dates promises étaient écrasables sans journal,
les unités reçues n'avaient pas de règle commune de normalisation, les tolérances
n'étaient pas datées et aucune file d'anomalies ne portait propriétaire, prochaine
action ou échéance. Un écart de prix semblait calculable depuis le prix commandé
alors que le dépôt ne contient aucune facture fournisseur autoritaire.

La répétition a également découvert un défaut dormant du rollback : le nouveau
script visait schema_migrations au lieu du registre canonique
cerp_schema_migrations. Le runner l'a détecté après application des huit patchs ;
le nom a été corrigé et toute la répétition a ensuite réussi.

## Choix d'architecture

- contrat serveur CERP-PROCUREMENT-1.0.0 avec définition, unité, période, source,
  fraîcheur, fiabilité, manquants, numérateur et dénominateur ;
- OTD sur cohorte de dates promises échues, variabilité en écart-type population
  de jours calendaires et taux de rejet pondéré par quantités normalisées ;
- historique append-only des promesses, politiques de tolérance datées et reçus
  d'idempotence append-only ;
- conversion d'unité uniquement si l'unité est identique ou si le coefficient
  explicite stock-par-unité-d'achat existe ;
- rapprochement commande → réception → contrôle → lot → documents ;
- anomalies déterministes : manquant, excédent, retard, unité incompatible, lot
  bloqué, document absent et contrôle obligatoire absent ;
- RBAC serveur, verrou optimiste, audit transactionnel et Idempotency-Key sur
  toutes les corrections ;
- factures, avoirs, retours et écart de prix fournisseur déclarés UNAVAILABLE
  plutôt que simulés.

## Fichiers modifiés

- nouveau module src/module/procurement-reliability avec domaine, validation,
  repository, contrôleur, routes et tests ;
- montage de route dans src/routes/v1.routes.ts ;
- intégration de l'événement de promesse initiale dans le workflow d'accusé
  fournisseur ;
- patch db/patches/20260812_procurement_reliability_sol18.sql et scripts support
  preflight, verify et rollback ;
- ajout de SOL-18 au runner scripts/migrations/release-gate.js ;
- tests de domaine, transactions, RBAC/routes et gardes migration ;
- ADR, rapport de répétition migration et présent rapport.

## Migration et changements de données

Le patch ajoute :

- procurement_promised_date_events ;
- procurement_anomaly_actions ;
- procurement_policy_versions ;
- procurement_command_receipts ;
- fn_procurement_evidence_append_only et trois triggers append-only.

Il ne réécrit aucune commande ni promesse historique. Les anciennes promesses
restent explicitement partielles. L'application du schéma doit précéder le nouvel
artefact backend.

Répétition PostgreSQL 16 jetable finale :

- source : 140 patchs appliqués, 8 attendus, 0 divergence de checksum ;
- sauvegarde : 1 954 339 octets, SHA-256
  ac0e6f9884f6296c408af4cc0146f322f99501afb80a1e823c637f9dfc4cfd82 ;
- migration : 277 ms, vérification 146 ms, rejeu 0 patch en 140 ms ;
- rollback test-only : passed en 110 ms ;
- restauration : passed en 4 233 ms ;
- empreintes source/restaurée identiques :
  95604517cb6cd91ff263ce0dce1ffeabd091c7fa45e9151c6f7c09761a635f09.

La base était liée à 127.0.0.1:55493, stockée en tmpfs et détruite après le test.
Aucune base persistante ou de production n'a été lue ou écrite.

## Tests exécutés

| Contrôle | Résultat réel |
|---|---|
| tests SOL-18 domaine/repository/routes/migration | PASS |
| suite backend complète | PASS — 923 fichiers, 4 506 tests réussis, 4 ignorés, 0 échec |
| pnpm typecheck | PASS |
| pnpm build | PASS — frontière données de production validée sur 648 sources et 648 fichiers émis |
| pnpm audit --audit-level high | PASS — aucune vulnérabilité connue |
| répétition migration complète | PASS — backup, preflight, 8 patchs, verify, replay, rollback, restore |
| E2E intégré inter-dépôts | PASS — 3/3, 148 migrations, retries à zéro |

L'E2E intégré crée réellement une commande fournisseur, la fait valider et envoyer,
enregistre l'accusé et sa promesse, puis couvre :

1. réception complète → contrôle → lot → stock → OTD constaté et historique ;
2. réception partielle → anomalie de quantité → affectation → retry idempotent.

## Vérification navigateur

Playwright Chromium a exécuté les trois parcours sur un frontend compilé, une API
compilée et PostgreSQL jetable. Le spec fonctionnel UI Commandes fournisseurs a
également passé 7/7 scénarios avec retries désactivés, dont accès refusé, erreur et
reprise, achat partiel, achat complet, scorecard, état indisponible et prise en
charge. Le premier essai avait révélé un readiness insuffisant du serveur Vite ;
Playwright construit puis sert désormais le bundle avec une frontière API locale
explicite avant de commencer.

## Risques, compatibilité et éléments restant à faire

- P1 : aucune facture fournisseur, ligne d'avoir ni workflow de retour fournisseur
  n'existe dans le schéma. L'écart de prix, les avoirs et retours restent
  indisponibles avec motif machine-readable. Prochaine action : décider puis
  concevoir ces trois sous-domaines et leur rapprochement comptable ;
- les dates promises antérieures à SOL-18 n'ont pas d'acteur ni de motif et
  abaissent la fiabilité à PARTIAL ;
- l'isolation disponible reste celle de la base CERP sélectionnée ; les tables
  achats ne portent pas encore de société/site autoritaire commun ;
- les gros chunks Vite existants restent un avertissement de performance sans
  échec de build ;
- le helper Project Office n'a pas pu publier l'avancement, faute de
  PROJECT_OFFICE_API_URL et de jeton dans cet environnement. L'issue Git #431
  reste la trace exploitable ;
- le patch n'a volontairement pas été appliqué sur HYPERBOX2 ou Coolify. Il doit
  passer par le gate de release, sauvegarde vérifiée et fenêtre autorisée.

## Rollback

Avant toute preuve SOL-18, le script support peut retirer les quatre tables, les
triggers, la fonction et l'entrée du registre. Après la première preuve, le script
refuse la suppression : redéployer l'artefact backend précédent, qui ignore les
tables additives. Si un retour de schéma est indispensable, geler les écritures et
restaurer le dump pré-migration dans une nouvelle base, vérifier son empreinte et
promouvoir la base restaurée.
