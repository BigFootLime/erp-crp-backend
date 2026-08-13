# CLAUDE-05 — Contrat historique E2E Outillage / Pièces techniques / GED

- Date d'exécution : 13 août 2026
- Responsable : Codex, pour Keenan Martin
- Dépôt : `BigFootLime/erp-crp-backend`
- Branche : `fix/633-sol20-isolated-outillage-contract`
- Checkpoint : `1e3e1e3`
- Portée : environnement E2E jetable uniquement

## Diagnostic et cause racine

Le runner SOL-05 reconstruisait une base historique minimale puis appliquait les
151 migrations. Ce baseline ne contenait pas toutes les tables legacy du
catalogue Outillage ni les colonnes historiques de référentiels encore lues par
les routes SOL-20. Les tests navigateur rencontraient donc :

- `42P01` sur les tables revêtements/arêtes de coupe ;
- `42703` sur `gestion_outils_historique_prix.id_historique` ;
- des colonnes absentes sur `pieces_families` et `centres_frais`.

Les routes existent et compilent, mais une base reconstruite depuis le contrat
historique ne reproduisait pas le comportement déployé. La cause était donc la
fixture de schéma E2E, pas une migration ou une logique métier SOL-20.

## Choix d'architecture

`db/e2e/historical-runtime-contract.sql` complète le baseline jetable avec les
objets historiques réellement requis : revêtements, liens outil/revêtement,
arêtes, liens géométrie/arête, valeurs d'arête, colonnes de famille/centre de
frais et clé d'historique de prix.

Le renommage `id` → `id_historique` est protégé par une vérification des deux
noms, donc sûr à rejouer. Le bloc de validation final échoue explicitement si le
contrat attendu n'est pas présent. Aucun endpoint, modèle, permission, migration
de production ou donnée métier n'est modifié.

## Fichiers modifiés

- `db/e2e/historical-runtime-contract.sql`
- `docs/execution-reports/CLAUDE-05.md`

## Tests exécutés

- `corepack pnpm typecheck` : réussi ;
- `corepack pnpm test:run` : réussi ;
- `corepack pnpm build` : réussi ;
- runner frontend `node scripts/e2e/run-isolated.mjs --workers=1 --retries=0
  e2e/claude05-tooling-ged-ui.spec.ts e2e/tooling-technical-ged.spec.ts` :
  8/8 scénarios réussis en 35,0 s ;
- migration isolée : 151 appliquées, 0 en attente, 0 checksum divergent ;
- contrôles post-application du contrat historique : réussis.

## Migrations et données

Aucune migration de production et aucun patch à appliquer sur les bases
HYPERBOX2/Coolify. Les objets ajoutés appartiennent exclusivement à la
reconstruction locale jetable SOL-05. La base et les fichiers temporaires ont
été détruits après la preuve.

## Risques et compatibilité

- le SQL est additif et idempotent dans le baseline E2E ;
- les clés étrangères reproduisent les liens réellement consommés ;
- une divergence future du schéma historique fera échouer le bloc de validation
  au lieu de produire des 500 tardifs ;
- ce fichier ne doit jamais être utilisé comme patch de production.

## Rollback

Annuler le commit backend CLAUDE-05. Aucune restauration de données n'est
nécessaire. Recréer ensuite une pile SOL-05 neuve : l'ancien défaut E2E doit
réapparaître, ce qui constitue aussi la preuve de portée du rollback.

## Reste réellement à faire

Aucun changement backend produit. Le seul élément connexe restant est l'alerte
de dépendance frontend `nanoid` documentée dans le rapport CLAUDE-05 frontend.
