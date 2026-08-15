# SOL-32 — MFA des comptes privilégiés

- Date d’exécution : 2026-08-15 (Europe/Paris)
- Propriétaire : Keenan Martin
- Issue : `BigFootLime/erp-crp-backend#522`
- Commit fonctionnel backend : `4cc18c139ac3838c1f18d2e44212d69217dd0234`
- Correctif de déploiement : `2add6c9` (`--only` immuable pour le patch SOL-32)
- Promotion fonctionnelle : PR `#523` vers `dev`, PR `#524` vers `main`
- Promotion du correctif : PR `#525` vers `dev`, PR `#526` vers `main`
- SHA backend déployé et vérifié : `91029c5f93d7b242cc6cbd1c08b5659cb738ccf8`

## Diagnostic et cause racine

Le socle ne disposait d’aucun second facteur serveur : un JWT de
superadministrateur suffisait pour toutes les mutations sensibles. Le frontend
ne pouvait donc pas compenser l’absence d’assurance MFA au niveau API.

Le premier déploiement Coolify de `bf6bd073…` a volontairement échoué au
preflight parce que `MFA_ROOT_KEY` n’était pas encore provisionnée ; l’ancienne
image saine est restée en service. La première tentative de migration réelle a
ensuite révélé un défaut de livraison distinct : le patch SOL-32 était absent du
registre immuable de `scripts/db-patches.js`. Le runner refusait donc de
l’appliquer seul alors que 19 patches historiques sont encore non enregistrés
sur `cerp_test` et 23 sur `cerp_prod`. Le correctif minimal ajoute le nom et le
SHA-256 canonique du patch, avec un test, sans modifier ces écarts antérieurs.

## Choix d’architecture

- TOTP RFC 6238, compatible avec les applications d’authentification standards ;
- secret chiffré AES-256-GCM, clé racine uniquement dans les coffres runtime ;
- challenge opaque, court, consommable une seule fois ;
- aucun JWT privilégié avant validation/enrôlement du facteur ;
- codes de secours à forte entropie, hachés et consommables une seule fois ;
- cinq erreurs verrouillent le challenge quinze minutes ; fenêtre TOTP ±1 pas ;
- step-up de cinq minutes sur les mutations administratives sensibles ;
- état du facteur relu en base afin d’invalider les sessions anciennes ou
  révoquées, sans faire confiance au frontend ;
- récupération hors bande par CLI avec acquittement daté, motif, audit et
  invalidation des sessions ;
- une même clé est utilisée par les processus Coolify/HYPERBOX2 qui peuvent
  servir les deux bases sélectionnables. Des clés distinctes ne seront possibles
  qu’après séparation stricte des processus ou ajout d’un keyring par base.

ADR : `docs/adr/ADR-0078-privileged-mfa-boundary.md`.
Runbook : `docs/runbooks/privileged-mfa-sol32.md`.

## Fichiers et contrats principaux

- migration et preflight/verify/rollback :
  `db/patches/20260815_privileged_mfa_sol32.sql` et `db/patches/support/*sol32*` ;
- domaine et persistance MFA : `src/module/auth/domain/mfa.ts` et repositories
  d’authentification ;
- contrôleurs/routes d’enrôlement, vérification, récupération et step-up ;
- middleware de step-up appliqué aux mutations sensibles ;
- commande `pnpm auth:mfa:recover` ;
- inventaire OpenAPI et tests de sécurité/RBAC/migration ;
- `scripts/db-patches.js`, corrigé pour sélectionner le patch SOL-32 par nom et
  checksum immuable.

Le frontend associé fournit les étapes login/enrôlement/vérification, le QR et
le secret manuel, l’acquittement avant stockage du token, le dialogue global de
step-up et le panneau Administration → Sécurité MFA. Aucun KPI, mock ou changement
visuel général n’a été ajouté.

## Tests et preuves reproductibles

Backend fonctionnel :

- `pnpm typecheck` : réussi ;
- 14 tests MFA/RBAC/migration ciblés : réussis ;
- `pnpm test:run` : sortie 0 ;
- `pnpm build` : réussi, 1 057 opérations OpenAPI, couverture inventaire 100 %,
  empreinte source `41438efe227f`, 729 fichiers runtime validés ;
- correctif runner : 21 tests `db-patches.runner.test.ts` réussis en 659 ms,
  typecheck et build réussis.

Frontend :

- typecheck et lint frontend : réussis ;
- 9 tests ciblés : réussis ;
- suite complète : 297 fichiers et 2 504 tests réussis en 116,85 s ;
- build : réussi, 11 885 modules ; avertissements de découpage préexistants ;
- Playwright sur pile jetable : un scénario complet réussi en 12,3 s après 162
  migrations et seed déterministe. Il couvre enrôlement privilégié, affichage
  unique des codes avant session, accès administration, consommation/rejeu d’un
  code de secours et verrouillage après cinq erreurs.

Répétition de migration isolée : 140 → 162 patches, zéro checksum divergent,
rejeu à zéro patch, restauration réussie ; dump 1 968 432 octets, SHA-256
`1715b92f0dbdcade9019bf3523018d9893a3927dfaaac7a1f1aa352835d8f1ce`,
empreinte métier identique avant/après restauration
`ca12781f9d6271d3cd9c95ac408d7f83c2d96b765aae62fbefaa3a4a636a9b71`.

## Bases réelles et sauvegardes

Avant écriture, deux dumps custom PostgreSQL 17.10 ont été créés sur HYPERBOX2,
protégés `root:root 0600` et inventoriés par `pg_restore -l` :

- `cerp_test_pre_sol32_20260815-044222.dump`, 73 115 005 octets, SHA-256
  `b1978a2aad5f3158a93928e30dd277cef95ab09e72e5f6101834b585ff87c9bb` ;
- `cerp_prod_pre_sol32_20260815-044222.dump`, 49 642 016 octets, SHA-256
  `113c2dbbb12b5d680a323ff0350bcee6626eb4f4741a59fb737bad19d42aaa7e`.

Le preflight a confirmé PostgreSQL 17.10 et un compte privilégié actif dans
chaque base. Le patch `20260815_privileged_mfa_sol32.sql` a été appliqué avec
`--only`, d’abord sur `cerp_test`, puis sur `cerp_prod`, enregistré dans
`cerp_schema_migrations`, et validé par le script post-migration. Résultat :
tables/contraintes/index/grants présents, zéro facteur créé artificiellement,
zéro checksum divergent.

## Déploiements et vérifications live

HYPERBOX2 :

- archive Git contrôlée SHA-256
  `3d8177b9a496d8330494244963c409c6b647b7c793913db6edc4a0b0a15122f4` ;
- release immuable `/srv/cerp/releases/20260815-91029c5f` ;
- `cerp-api-test` puis `cerp-api` actifs ; liveness/readiness HTTP 200 ;
- version exacte `91029c5f…`, DB/GED/ClamAV/realtime `up` et fiabilité
  `MEASURED` ; endpoint administration anonyme refusé en 401.

Coolify :

- variables runtime `MFA_ROOT_KEY` et `MFA_KEY_ID` stockées chiffrées, jamais
  imprimées et absentes du build time ;
- déploiement `t75wh7qtdxcjh7y5gube6ft5`, terminé avec succès de 04:55:46 à
  04:59:36 UTC ; un seul conteneur `91029c5f…` sain après rolling update ;
- `/health/live` et `/health/ready` publics à 200, version exacte, quatre
  dépendances obligatoires `up` ; endpoint administration anonyme à 401 ;
- frontend Coolify `90cc4d37…` sain.

## Risques, compatibilité et rollback

Les superadministrateurs existants doivent s’enrôler à leur prochaine connexion ;
les anciens JWT sans assurance MFA ne peuvent plus exercer un privilège. Les
comptes non privilégiés conservent le parcours mot de passe existant.

Le registre live conserve 19 patches historiques en attente sur test et 23 sur
production. Aucun n’a été appliqué ou baseliné implicitement pendant SOL-32.
Cet écart préexistant est P1 : il doit être rapproché patch par patch (objet
réel, checksum, décision appliquer/baseliner/abandonner) avant le contrôle final
SOL-43. Il ne remet pas en cause l’enregistrement vérifié de SOL-32.

Rollback applicatif : retirer uniquement le drop-in
`zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-sol32-91029c5f.conf`, recharger
systemd, redémarrer test puis production, ou redéployer l’image Coolify
précédente. Conserver les tables dès qu’un facteur a existé. Avant tout rollback
SQL, vérifier qu’aucun facteur n’a jamais été actif ; sinon restaurer le dump
dans une base neuve selon le runbook SOL-06. La clé reste dans les coffres
runtime et ne doit jamais être supprimée tant que des facteurs chiffrés existent.

## Reste réellement à faire

- faire enrôler Keenan puis un second superadministrateur et conserver les codes
  de secours hors ligne ;
- exécuter la revue dédiée des 19/23 patches historiques avant SOL-43 ;
- la rotation de la clé racine reste une opération contrôlée de remplacement des
  facteurs, pas une rotation automatique susceptible de rendre les secrets
  existants indéchiffrables.
