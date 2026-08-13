# SOL-19 — Stock et réapprovisionnement (backend)

- Date : 2026-08-13
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/436
- Branche de travail : `feature/436-sol19-stock-intelligence`
- Base initiale : `origin/dev` (`18b1906`)
- ADR : `docs/adr/ADR-0065-stock-intelligence-and-replenishment-projection.md`

## Diagnostic et cause racine

Le moteur de propositions d'achat savait déjà traiter unités, MOQ, lots d'achat,
idempotence et concurrence, mais les indicateurs de pilotage étaient dispersés.
La projection ne rapprochait pas dans un même contrat le stock utilisable, les
réservations OF, les réceptions fermes, la quarantaine et la fiabilité des preuves.
Les besoins OF non réservés et les couches CUMP par lot ne sont pas persistés dans
le modèle actuel : leur déduction aurait fabriqué de la donnée.

## Choix d'architecture et résultat

- contrat serveur `CERP-STOCK-INTELLIGENCE-1.0.0` ;
- politiques ABC/couverture/dormance/inventaire versionnées et append-only ;
- lecture par article et magasin depuis la vue de disponibilité, mouvements,
  réservations, commandes fournisseurs et inventaires ;
- valeur, rotation, couverture, dormance, exactitude et ABC avec définition,
  unité, période, source, fraîcheur, fiabilité et manquants ;
- projection glissante sur 13 semaines et date de rupture explicable ;
- snapshot de lecture `REPEATABLE READ READ ONLY`, échéances dépassées ramenées
  au premier jour et refus des additions multidevises ;
- simulation `POST` sans écriture avec `write_performed: false` ;
- RBAC serveur, coûts masqués sans permission, politique sensible auditée,
  idempotente et transactionnelle ;
- aucune quantité inconnue convertie en stock disponible ou en zéro financier.

Les capacités manquantes sont rendues machine-readable :
`OF_MATERIAL_REQUIREMENT_SOURCE_NOT_PERSISTED` et
`CUMP_COST_LAYER_NOT_MATERIALIZED_PER_LOT`.

## Fichiers modifiés

- `src/module/stock-intelligence/` : domaine, repository, contrôleur, validation et tests ;
- `src/module/stock/routes/stock.routes.ts` : montage des trois routes sécurisées ;
- `src/__tests__/stock-intelligence-sol19.routes.test.ts` : autorisations négatives et idempotence ;
- `src/__tests__/stock-intelligence-sol19.migration-guards.test.ts` : gardes SQL ;
- `db/patches/20260813_stock_intelligence_sol19.sql` ;
- `db/patches/support/20260813_stock_intelligence_sol19.{preflight,verify,rollback}.sql` ;
- `scripts/migrations/release-gate.js` et preuves `MIGRATION_REHEARSAL_SOL_06` ;
- ADR-0065 et présent rapport.

## Migration et changements de données

Le patch ajoute `stock_intelligence_policy_versions` et
`stock_intelligence_command_receipts`, toutes deux append-only. Il ne réécrit ni
stock, ni mouvement, ni commande. Aucune politique fictive n'est insérée.

Répétition PostgreSQL 16 jetable :

- base initiale : 140 patchs appliqués, 9 attendus, 0 checksum divergent ;
- sauvegarde : 1 954 339 octets, SHA-256
  `52275685164f28b972461fb5460a71e97315b86eff5d4265c038f43e61598de3` ;
- après migration : 149 patchs appliqués, 0 attendu ;
- migration : 264 ms ; verify : 166 ms ; rejeu : 0 patch en 116 ms ;
- rollback test-only : réussi en 121 ms, tables SOL-19 retirées ;
- restauration : réussie en 3 965 ms, comptages identiques ;
- environnement : `127.0.0.1:55436`, `cerp_test`, stockage tmpfs, détruit après test.

Aucune base persistante ni production n'a été lue ou écrite.

## Tests exécutés et résultats

| Contrôle | Résultat réel |
|---|---|
| tests SOL-19 domaine/repository/routes/migration + régression propositions/stock | PASS — 7 fichiers, 42 tests |
| suite backend complète `pnpm test:run` | PASS — 0 échec, 68,9 s |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS — frontière de production validée sur 654 sources et 654 fichiers émis |
| `pnpm audit --audit-level high` | PASS — aucune vulnérabilité connue |
| `pnpm db:migrations:rehearse` | PASS — backup, preflight, 9 patchs, verify, replay, rollback et restore |
| E2E inter-dépôts isolé | PASS — 2/2 en Chromium, 149 migrations, contrat PostgreSQL réel et simulation sans écriture |

## Vérification navigateur/E2E

Playwright a démarré PostgreSQL jetable, appliqué 149 migrations, chargé sept
utilisateurs déterministes, compilé l'API et le frontend, puis :

1. s'est authentifié et a validé le contrat réel de l'API stock intelligence ;
2. a couvert rupture → proposition → projection → simulation ;
3. a vérifié que la seule mutation émise est la simulation et que sa réponse
   confirme `write_performed: false`.

## Risques, compatibilité et travail restant

- P1 : les besoins matière OF non réservés ne sont pas persistés. La projection
  n'utilise donc que les réservations actives datables et reste `PARTIAL` ; action
  exacte : créer une source versionnée des besoins matière OF avant réservation ;
- P1 : les couches de coût CUMP par lot ne sont pas matérialisées. La valeur reste
  `ESTIMATED` ou `UNAVAILABLE` ; action exacte : persister les couches de
  valorisation et les rapprocher aux mouvements ;
- la politique par défaut est explicite et non une décision métier enregistrée.
  Un responsable référentiel peut publier une version datée et sourcée ;
- l'isolation disponible reste celle de la base sélectionnée ; aucun axe société/site
  commun n'existe dans les sources stock actuelles ;
- le patch n'a volontairement pas été appliqué aux bases HYPERBOX2/Coolify : une
  écriture production exige sauvegarde validée et fenêtre autorisée ;
- Project Office n'est pas configuré dans cet environnement ; l'issue #436 sert de
  trace de reprise.

## Rollback

Avant toute politique ou reçu, exécuter le rollback support après sauvegarde et
vérifier `stock_intelligence_removed=true`. Après la première preuve, le rollback
refuse la perte : redéployer l'ancien backend, qui ignore les tables additives.
Pour retirer le schéma, geler les écritures, restaurer le dump pré-migration dans
une nouvelle base, vérifier checksum/comptages, puis promouvoir cette base.
