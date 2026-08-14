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
