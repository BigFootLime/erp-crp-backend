# SOL-07 — Frontière des données de production backend

Date : 2026-08-10
Branche : `fix/sol-07-production-data`
Base : `origin/dev` au commit `8947061673133130d70199c68375458116f1fede`

## Diagnostic et cause racine

Une fixture documentaire OF vivait sous `src/module/production/domain/__fixtures__`. Le build TypeScript inclut `src/**/*.ts` et exclut seulement `src/__tests__` : cette fixture était donc éligible à l’émission dans `dist`, même si aucun module runtime ne l’importait.

## Correction et architecture

- Fixture déplacée vers `test-support/production` hors racine compilée.
- Trois suites OF adaptées sans modifier leurs assertions.
- Garde-fou `security:production-data` ajouté : refus des imports runtime `fixture`, `mock` et `demo`.
- Build renforcé par un contrôle avant compilation puis un contrôle des 618 fichiers émis.
- Analyse du contrat stock documentée : rupture actuelle et réservation à risque ne sont pas une prévision à sept jours.

## Fichiers modifiés

- `package.json`
- `scripts/security/check-production-data-boundary.mjs`
- `test-support/production/of-document.fixture.ts`
- trois tests OF sous `src/__tests__`
- `docs/release/PRODUCTION_DATA_BOUNDARY.md`
- ce rapport

## Migrations et données

Aucune migration ni donnée métier modifiée. Pour la preuve navigateur frontend, le flag ARIANE a été activé temporairement dans `cerp_test`, base PostgreSQL jetable en mémoire, puis le conteneur a été détruit. Aucune base de production n’a été contactée.

## Tests exécutés

- `pnpm install --frozen-lockfile` — succès, lockfile inchangé.
- `tsc -p tsconfig.json` — succès.
- Trois suites OF ciblées — 84 tests réussis.
- Suite backend complète — succès (commande Vitest complète, code retour 0).
- Frontière source — 618 fichiers runtime, succès.
- Frontière `dist` — 618 fichiers émis, succès.

## Navigateur / E2E

Non applicable au déplacement de fixture backend. La preuve utilisateur est portée par le frontend SOL-07.

## Risques, compatibilité et rollback

La fixture reste accessible à Vitest mais ne fait plus partie du build. Aucun contrat API ne change. Le rollback consiste à revert SOL-07 ; il réintroduit toutefois le risque d’émettre la fixture dans `dist`. Aucun rollback de base n’est requis.

## Reste réellement à faire

Un futur contrat de prévision de rupture doit définir demande datée, réceptions attendues, horizon, unité, périmètre société/site, fraîcheur et niveau de confiance avant toute exposition à ARIANE.
