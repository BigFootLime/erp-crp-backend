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

Le contrôle live en lecture seule après promotion révèle un retard historique
hors périmètre SOL-10 : `cerp_prod` = 116 patches appliqués / 25 en attente,
`cerp_test` = 121 / 20, avec zéro mismatch de checksum. Le preflight production
refuse `stock.valuation_method` non sourcé ; le preflight test refuse l'entrée
inconnue `20260731_ged_fiches_360.sql`. Aucune migration n'a été lancée. Les
sauvegardes vérifiées avant décision sont :

- production : `cerp_prod_pre_sol10_20260810-180102.dump`, 49 303 152 octets,
  SHA-256 `9eecfd63c70263495e1dda07a654056cfa449030b77e0528a06a57f178ec19d4` ;
- test : `cerp_test_pre_sol10_20260810-180102.dump`, 72 763 571 octets,
  SHA-256 `f0d8111666be3327a7c23d5a36906ad0a375fbfc3fbc773b03857513feacd076`.

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
n'est à restaurer pour ce correctif.

Preuves live : `main` = `d7cb2ef`; le webhook Coolify a construit l'image,
validé 624 fichiers source et 624 fichiers émis, puis terminé le rolling update
en état `healthy`. Le preflight login public répond `204` et autorise/expose les
deux IDs de corrélation ; `/health/live` répond `200`. La readiness a mis en
évidence que la GED locale VPS était exigée alors que la GED production est
routée vers HYPERBOX2. Une variable Coolify runtime-only unique exige désormais
DB, antivirus et temps réel ; son redéploiement final doit encore être attesté.

Sur HYPERBOX2, `/srv/cerp/releases/20260810-d7cb2ef` est construit et vérifié,
mais le service reste volontairement sur `20260805-f0ee008`. Le dépôt ancien
contient de nombreux changements locaux et les gates DB sont rouges : le
basculer maintenant mélangerait des travaux dormants et du code dépendant de
schémas absents. Prochaine action exacte : réconcilier le ledger test, obtenir la
décision de valorisation, répéter les patches sur copie jetable, puis suivre la
fenêtre SOL-06 avant la bascule systemd. Rollback atelier : retirer le futur
override de release et redémarrer `cerp-api`, ce qui réactive `f0ee008`.
