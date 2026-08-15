# Rapport d'exécution — SOL-40 (backend)

- Date : 2026-08-15
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/549
- Branche : `docs/549-sol40-i18n-mobile-gate`
- Base : `origin/main` `2465761b99ff5e511fa004b09ecb50da36bd6e64`
- Verdict : **NO-GO extension internationale/mobile sans besoin commercial**

## Diagnostic et cause racine

Le modèle sait stocker une langue et une devise sur certains objets, mais aucun
usage réel ne prouve une conversion ou une autre locale. Une liste de quatre devises
sans taux datés ne permet pas de calculer. Le besoin mobile est déjà couvert par des
surfaces web ciblées ; aucune contrainte matérielle ne justifie une application
séparée.

## Preuves mesurées

- `cerp_prod` en `BEGIN READ ONLY` : 191 clients `fr`, 191 clients `EUR` ;
- référentiel devises : CHF, EUR, GBP et USD, sans table de taux datés ;
- 0 facture, 0 commande client, 0 commande fournisseur et 0 devise transactionnelle ;
- aucun besoin commercial i18n/PWA/mobile dans les issues ;
- le backend conserve déjà les montants par devise et refuse les agrégats
  inter-devises sans source de change.

Une première requête d'introspection a référencé à tort `currencies.is_active` ; la
transaction read-only a été annulée automatiquement. La requête corrigée a lu le
schéma réel (`code`, `name`) et s'est terminée par `COMMIT`, sans écriture.

## Architecture

`ADR-0085` définit le gate commercial, les clés/locales futures, le gel de langue des
documents, la preuve complète d'un taux et le choix PWA/native fondé sur le matériel.
Les API et permissions existantes restent l'unique source métier.

## Fichiers, migrations et données

- `docs/adr/ADR-0085-internationalization-currency-mobile-gate.md` ;
- `docs/execution-reports/SOL-40.md`.

Aucun endpoint, devise, taux, traduction, migration, secret ou donnée n'est ajouté.

## Tests et vérifications

| Contrôle | Résultat |
|---|---|
| audit production read-only | PASS après correction d'introspection |
| recherche schéma/taux/issues | PASS |
| validation UTF-8 des Markdown | PASS — 2 fichiers sur 2 |
| `git diff --check` | PASS |

Les tests runtime et E2E backend sont non applicables à ce diff documentaire. Le
frontend exécute séparément les tests des parcours ciblés existants.

## Risques, compatibilité et rollback

- Toute conversion sans taux daté serait fausse ; elle reste interdite.
- Les documents émis ne pourront jamais changer de langue ou de taux rétroactivement.
- Une PWA ne doit pas mettre en cache génériquement les données authentifiées.
- Le modèle actuel `fr`/EUR et les parcours web restent inchangés.

Revenir sur le commit retire seulement l'ADR et le rapport ; aucun rollback SQL ou
applicatif n'est requis.

## Reste réellement à faire

1. Confirmer marché, locales, règles légales, devises et appareils.
2. Choisir et contractualiser la source de taux Finance.
3. Prioriser trois à cinq parcours mobiles et qualifier le matériel.
4. Implémenter alors par lots, avec locale/taux figés et tests de sécurité/hors ligne.
