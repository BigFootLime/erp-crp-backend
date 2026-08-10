# Rapport d'exécution SOL-10 — backend

Date : 2026-08-10. Branche : `fix/sol-10-encrypted-backup`.

## Diagnostic

Le backend ne fournissait pas d'export cohérent associant dump PostgreSQL,
ledger, contraintes, prérequis et références GED. La restauration ne comparait
pas l'état restauré à l'état du snapshot. En parallèle, les déploiements Coolify
échouaient : `npm run build` invoquait le contrôle de frontière, mais l'étape
builder du Dockerfile ne copiait pas `scripts/security`.

## Architecture et fichiers

- `scripts/backup/recovery-set.mjs` exporte sous transaction repeatable-read,
  vérifie les fichiers référencés et restaure uniquement vers une DB isolée vide ;
- `Dockerfile` copie les gardes sécurité avant le build, contrat commun Coolify
  et image de release ;
- `src/__tests__/dockerfile.storage.test.ts` verrouille l'ordre de copie/build ;
- `src/__tests__/cors.config.test.ts` verrouille le preflight de production avec
  `X-Request-Id` et `X-Correlation-Id`.

## Données et migrations

Aucun SQL ni changement de données. Les deux restaurations de preuve ciblent des
bases Docker vides et jetables ; les noms de DB production sont refusés.

## Tests avant promotion

- `pnpm run build` : PASS, frontière contrôlée sur 624 fichiers source et émis ;
- tests ciblés Docker/CORS : PASS, 2 fichiers / 7 tests ;
- suite `pnpm test:run` : PASS, code retour 0 en 25,4 s ;
- `docker build --tag cerp-backend-sol10-verify:local .` : PASS en 34,9 s ;
- rehearsal frontend pilotant ce backend : deux restaurations DB + GED et
  démarrage `/health/live`, `/api/v1/environment`, `/health/ready` réussis.

## Compatibilité, rollback et reste à faire

Le changement Docker est additif et ne modifie pas l'image runtime finale hors
code déjà produit. Rollback : redéployer l'image/commit précédent ; aucune donnée
n'est à restaurer pour ce correctif. Après promotion, vérifier Coolify et le
service systemd HYPERBOX2 au même SHA, puis les headers CORS et la readiness.
