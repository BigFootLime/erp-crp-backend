# Rapport d'exécution — SOL-27

- Date : 2026-08-14
- Issue backend : https://github.com/BigFootLime/erp-crp-backend/issues/480
- Branche : `feature/480-sol27-accounting-export`
- Base : `origin/dev` `9a8db7cc8c47b59272a5a1acd207e6a7277e1c34`
- Statut avant promotion : fonctionnel et testable ; qualification du logiciel
  comptable externe volontairement non revendiquée

## Diagnostic et cause racine

Les pièces Finance existaient, mais aucune frontière d'export ne garantissait
équilibre, unicité, version du plan comptable, reprise idempotente ou traçabilité du
fichier remis. Aucun logiciel comptable prioritaire ni contrat d'import n'est fourni.
La solution honnête est donc un noyau canonique avec un premier format délimité
générique, pas un faux connecteur Sage/Cegid/EBP.

La répétition réelle a aussi révélé un défaut connexe : le trigger d'immutabilité
partagé lisait des colonnes propres à `facture` sur une ligne `avoir`, ce qui bloquait
l'émission d'un avoir. Le patch utilise désormais un accès JSON sûr tout en gardant
l'exception de règlement des factures.

## Architecture livrée

- moteur monétaire exact pour factures, avoirs et paiements ;
- mappings datés/versionnés : journaux, comptes, tiers, TVA, banque et axes ;
- interface `AccountingExportAdapter` et adaptateur `GENERIC_DELIMITED_V1` ;
- cycle prévisualiser, valider, générer, annuler logiquement et réexporter ;
- empreintes source/lignes/artefact et rapport ERP ↔ export par devise ;
- réservations uniques des sources, reçus d'idempotence et audit Finance ;
- capacités serveur distinctes lecture/exécution/administration.

Voir `docs/adr/ADR-0073-accounting-export-boundary.md`.

## Fichiers et données

- domaine/API : `src/module/accounting-export/` et `src/routes/v1.routes.ts` ;
- RBAC : `src/module/facturation/domain/finance-policy.ts` ;
- schéma : `db/patches/20260814_accounting_export_sol27.sql` et supports ;
- runner DB réel : `scripts/e2e/accounting-export-sol27-run.js` ;
- répétition de migration : `scripts/migrations/release-gate.js` ;
- procédure : `docs/runbooks/accounting-export-sol27.md`.

Le patch additif crée six tables : versions de mapping, lots, sources figées,
lignes, réservations et reçus de commande. Contraintes et triggers imposent côtés
débit/crédit, devises, statuts, empreintes, preuve d'artefact et immutabilité. Aucune
configuration comptable réelle n'est inventée ou injectée.

## Tests exécutés

| Contrôle | Résultat |
|---|---|
| `pnpm typecheck` | PASS |
| tests SOL-27 domaine, validation, RBAC, migration | PASS — 12 tests |
| `pnpm test:run` backend complet | PASS — exit 0 |
| `pnpm build` backend | PASS — 695 fichiers runtime contrôlés |
| E2E PostgreSQL isolé | PASS — 1/1, workflow complet et reprise idempotente |
| répétition migration PostgreSQL 16.14 | PASS — 18 patches, rejeu 0, rollback et restauration |
| audit dépendances production backend | PASS — 0 vulnérabilité connue |

Le scénario PostgreSQL couvre prévisualisation, validation, génération, retry avec
la même clé, SHA artefact, doublon, annulation, réexport, source devenue obsolète et
audit. La base est temporaire, en `tmpfs`, liée à `127.0.0.1`, puis détruite.

La répétition a sauvegardé 1 968 442 octets (SHA-256
`2736b95040d018030db6eb91a022fb0f52c2eb4ecd45da1722d9a7cf2bf4de91`), migré en
626 ms, validé en 229 ms, rejoué en 128 ms, rollbacké en 411 ms et restauré en
4 057 ms. Comptages restaurés identiques ; aucun checksum divergent.

## Vérification navigateur/E2E

Playwright Chromium sur build de production et contrat API intercepté : 1/1 PASS en
31,3 s. Le scénario parcourt l'onglet, le mapping, la prévisualisation, les bloqueurs,
la validation, la génération et le téléchargement. La preuve métier backend reste
le test PostgreSQL réel ci-dessus ; l'interception navigateur ne la remplace pas.

## Risques, compatibilité et rollback

- Le CSV générique n'est pas déclaré compatible avec un logiciel externe non choisi.
- La première version de mapping doit être validée par le comptable ; son absence
  bloque la génération, conformément au besoin.
- Le frontend signale encore les chunks historiques > 500 kB ; SOL-27 n'ajoute pas
  de refonte de chargement et ce warning n'affecte pas l'intégrité comptable.
- Le schéma est additif. Redéployer le SHA précédent conserve les preuves. Le rollback
  SQL n'est autorisé que sur une base test sans lot ; sinon restaurer le dump dans une
  nouvelle base. Le trigger d'avoir corrigé n'est volontairement pas régressé.

## Reste réellement à faire

1. Keenan Martin choisit le logiciel comptable prioritaire et fournit sa spécification
   d'import ainsi qu'un environnement test.
2. Le comptable valide journaux, comptes, axes, TVA, modes et dates d'effet.
3. Qualifier l'import réel, le rejet, le doublon, la contrepassation et le
   rapprochement ; ajouter ensuite un adaptateur fournisseur si nécessaire.
4. Import final, lettrage, clôture, déclarations et paie restent hors CERP+.

## Promotion, migration et déploiement réels

Le commit fonctionnel `f1f5a3f5459d5e231fac26573988332e85083ddd` a été fusionné
par la PR backend #481 vers `dev`, puis la PR #482 vers `main`. Après cette
promotion, `dev=4b242021c22cf154d0416d34c651dbdbafa59593` et
`main=b5790fb3b41993b7248721729a3b7a3f560aaf51`. Les worktrees officiels
locaux ont été avancés en fast-forward, sans toucher aux arbres WIP.

### Bases réelles HYPERBOX2

Le preflight PostgreSQL 17.10 a réussi sur `cerp_test` (146 MB) et `cerp_prod`
(103 MB). Aucune pièce n'était encore éligible. Il a signalé honnêtement 23 clients
sans compte tiers en test et 22 en production ; un futur lot les bloquera jusqu'à
configuration.

| Base | Sauvegarde | Taille | SHA-256 | Catalogue |
|---|---|---:|---|---:|
| `cerp_test` | `/var/backups/cerp/cerp_test_pre_sol27_20260814-182357.dump` | 75 174 443 octets | `6a67f8c48d210f5652415e2c4c2bbc9f131fc036e3881b96c836fa927b604c78` | 4 441 entrées |
| `cerp_prod` | `/var/backups/cerp/cerp_prod_pre_sol27_20260814-182357.dump` | 51 689 827 octets | `0a377333b0c48b8e9e93c8583cce23f749ce803a142341db433ca0a21b819f18` | 4 419 entrées |

Le dry-run immuable a sélectionné exactement SOL-27. L'application a duré 99 ms
sur `cerp_test`, puis 106 ms sur `cerp_prod`. Les vérifications confirment six
tables, zéro lot, zéro claim et zéro groupe de devise déséquilibré. Le rejeu a
appliqué zéro patch dans chaque base, sans divergence de checksum.

Le dump production a été restauré dans
`cerp_restore_verify_sol27_20260814` : 105 584 307 octets, 191 clients, zéro
facture/avoir/paiement, schéma et ligne de registre SOL-27 absents comme attendu.
La base temporaire explicitement identifiée a ensuite été supprimée.

### Applications

HYPERBOX2 exécute la release immuable
`/srv/cerp/releases/20260814-b5790fb3` pour `cerp-api-test` et `cerp-api`.
Les deux readiness retournent `200`, le SHA complet et les quatre dépendances DB,
GED, antivirus et realtime à `up`. La route `/api/v1/accounting-exports/batches`
retourne `401` sans JWT. Le frontend atelier pointe atomiquement vers
`/srv/cerp/frontend-releases/20260814-43b1eb7f/dist` et répond `200`.

Coolify a automatiquement construit les deux `main`. Les conteneurs frontend
`o00cgcso04ww0ggsgkg4wgg8-161915576493` et backend
`rcccokw0wgcw0ck44g0wk0ck-161916101918` sont `healthy`. Le backend public expose
`b5790fb3b41993b7248721729a3b7a3f560aaf51`, le bundle public contient
`43b1eb7ff8eae56531867f4f2bbabdbb261c02b2`, les pages répondent `200` et l'accès
anonyme à l'export retourne `401`.

### Observation connexe

Lors du redémarrage de l'ancien backend test, son arrêt gracieux a atteint son délai
interne de 10 secondes avant que systemd ne lance correctement la nouvelle release.
Le nouveau service est resté sain. Ce défaut d'arrêt historique est P2, hors calcul
comptable ; prochaine action : instrumenter les ressources encore ouvertes pendant
`SIGTERM`, sans augmenter le timeout comme correctif unique.
