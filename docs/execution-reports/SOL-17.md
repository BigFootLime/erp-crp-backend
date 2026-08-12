# SOL-17 — Clients, devis et commandes clients (backend)

- Date : 2026-08-12
- Issue : [#420](https://github.com/BigFootLime/erp-crp-backend/issues/420)
- Branche : `feature/420-sol17-commercial-reliability`
- Commits fonctionnels avant documentation : `2112e95`, `c5f332f`

## Diagnostic et cause racine

Les sources commerciales existaient mais n'avaient ni journal commun des décisions
de devis, ni validation de remise liée au contenu, ni reçu d'idempotence commun. La
conversion pouvait être assimilée au statut accepté et les révisions pouvaient
doubler les cohortes. Le reporting ne reliait pas dans un contrat unique facturé,
impayés, backlog, marge qualifiée, risque et chronologie de production.

Le premier passage de la suite complète a aussi révélé une assertion héritée de
SOL-16 : elle exigeait « Indisponible » pour toute métrique différée alors que l'OTIF
possède désormais une formule autoritaire sur une autre route. Le test distingue
maintenant cette délégation documentée sans rendre l'OTIF historique plus fiable.

## Choix d'architecture

- contrat serveur `CERP-COMMERCIAL-1.0.0`, valeurs `null` en cas d'absence et refus
  409 des agrégats multi-devises ;
- dernière version par racine de devis, conversion prouvée par une commande liée et
  non annulée ;
- marge `QUOTED` masquée si la couverture n'est pas complète ;
- risques catégoriels fondés sur des faits, exceptions avec responsable et prochaine
  action ;
- événements et annulations append-only, audit transactionnel, RBAC serveur et reçus
  d'idempotence ;
- chronologie source de bout en bout, sans événement synthétique.

La définition détaillée est dans `docs/adr/ADR-0063-commercial-reliability-boundary.md`.

## Fichiers modifiés

- nouveau module `src/module/commercial-reliability/` (domaine, validation,
  repository, contrôleur, routes et tests) ;
- workflow commande, repository devis, reporting v2 et route facturation ;
- contrat généré `contracts/commande-client-workflow.v1.json` ;
- patch SQL SOL-17 et scripts `preflight`, `verify`, `rollback` ;
- tests de workflow devis/commande, RBAC, idempotence, migration et contrat OTIF ;
- ADR, répétition de migration et présent rapport.

## Migration et données

`20260812_commercial_reliability_sol17.sql` ajoute
`commercial_quote_events`, `commercial_order_cancellations`,
`commercial_command_receipts` et la garde append-only. Il ne modifie et ne
rétro-remplit aucune donnée historique. SHA-256 normalisé enregistré par le runner :
`9da8fc1d7a71a5cf1133995de85d2c2680eeec5f7d7ffbcaa826351d8f35e97e`.

Répétition PostgreSQL 16 jetable finale :

- sauvegarde 1 954 319 octets, SHA-256
  `97efcd6ac410312fe0ea5d5c61c6cdc4a2a4477e8d3f951e46cb3ae454518eca` ;
- preflight : 140 patches appliqués, 7 attendus, 0 checksum divergent ;
- migration : 223 ms, 147 appliqués, vérification 132 ms, rejeu 0 patch ;
- intégrité post-migration : `passed` ;
- rollback SOL-17 : tables et fonction retirées, preuve globale `passed` en 72 ms ;
- restauration : 3 861 ms, comptages identiques et empreinte source/restaurée
  `d33b4e782dab383bc42a7a6d32f5b842080fb9e800d2bc27c415598bdfe1f00f` ;
- conteneur tmpfs et sauvegarde temporaire détruits après le test.

Aucune base persistante ou de production n'a été lue ou écrite.

## Tests exécutés

| Contrôle | Résultat réel |
|---|---|
| domaine/repository/routes/devis SOL-17 ciblés | PASS — 5 fichiers, 52 tests |
| workflow commande | PASS — 17 tests |
| reporting SQL + domaine/repository SOL-17 | PASS — 83 tests |
| garde migration finale | PASS — 4/4 |
| contrat reporting hérité corrigé | PASS — 92/92 |
| suite backend complète | PASS — code 0, 64,5 s |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS — frontière production 643 sources / 643 fichiers émis |
| répétition migration complète | PASS — sauvegarde, 7 patches, verify, rejeu, rollback, restauration |
| E2E isolé inter-dépôts | PASS — 3/3, 147 migrations, 1,1 min Playwright |

Les E2E couvrent conversion V1→V2 sans double comptage, annulation et retry,
refus après livraison partielle ou facture, chronologie
commande→analyse→OF→production→livraison→facture et le parcours achat complet.

## Vérification navigateur

Sur la pile isolée, connexion à `cerp_test`, ouverture du Reporting commercial puis
de l'onglet « Risques & actions ». Les métadonnées, le statut partiel, la conversion
absente affichée `—`, la marge indisponible sans zéro et les états vides actionnables
ont été vérifiés. Deux erreurs console `legacy_browser_console` correspondent au live
dégradé déjà visible hors SOL-17 ; aucune erreur de l'API commerciale n'a été relevée.

## Risques, compatibilité et reste à faire

- les devis antérieurs n'ont pas d'événements `SENT/LOST` : délai et motifs restent
  honnêtement partiels ;
- l'isolation société/site ne peut pas être filtrée plus finement que la base CERP
  tant qu'un lien autoritaire n'existe pas dans les tables commerciales ;
- les gros chunks Vite existants restent un avertissement de performance, sans échec
  de build ;
- diagnostiquer séparément le live dégradé/`legacy_browser_console` ;
- appliquer le patch sur une base persistante uniquement par le gate de release,
  pendant une fenêtre autorisée, avec sauvegarde validée.

## Rollback

Avant toute preuve SOL-17 sur une base jetable, utiliser le script de rollback avec
son jeton de session, puis vérifier l'absence des quatre objets. Après création d'une
preuve en production, ne pas supprimer les tables : redéployer les artefacts
précédents compatibles. Pour un retour de schéma imposé, arrêter les écritures et
restaurer le recovery set pré-migration dont le checksum a été vérifié.
