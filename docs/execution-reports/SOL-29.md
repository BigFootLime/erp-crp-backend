# SOL-29 — Portail client minimal et isolé

- Date : 2026-08-14
- Propriétaire : Keenan Martin
- Issue : `BigFootLime/crp-systems-web#704`
- Branche : `feature/704-client-portal`
- Statut : terminé, migré et déployé sur HYPERBOX2 et Coolify ; preuves de clôture ci-dessous.

## Diagnostic et cause racine

L'ERP ne possédait pas de frontière client dédiée. Réutiliser les comptes internes, leurs JWT ou les routes ERP aurait permis une confusion de rôles et aurait fait dépendre l'isolation du navigateur. La GED ne disposait pas non plus d'une publication explicite, révocable et limitée à un client.

Pendant l'E2E réel de téléchargement, Node 24 a révélé un second défaut : la lecture d'intégrité via `for await` fermait implicitement le descripteur partagé avant la diffusion HTTP (`EBADF`). Le téléchargement est maintenant vérifié par lectures positionnelles bornées sur le même `FileHandle`, puis diffusé avec ce descripteur encore ouvert.

La première tentative opérateur de migration réelle a également été arrêtée avant écriture : le patch n'était pas inscrit dans le registre immuable accepté par `db:patches --only`. Le correctif enregistre son SHA-256 canonique `d5c203c1c44f61b2b296d8fd08a5a35eb8b65060200119cbf7fe873f215d0f5c` et l'ajoute au test exhaustif du registre.

## Choix d'architecture et frontière de données

- Les comptes portail sont séparés des utilisateurs ERP. Ils ont leur propre secret JWT, audience `cerp-client-portal`, expiration de 15 minutes, statut et `session_epoch` relus en base à chaque requête.
- Le navigateur ne transmet jamais de `client_id`. Toutes les requêtes partent de l'identité portail et utilisent des vues SQL à projection explicitement autorisée.
- Les invitations et récupérations sont à usage unique ; seul le SHA-256 du jeton est conservé. Les mots de passe sont hachés avec bcrypt coût 12.
- Les créations et invitations administratives sont idempotentes. Les limites de débit sont persistées en PostgreSQL et verrouillées de façon déterministe sur IP et identifiant.
- Les commandes, livraisons et factures exposées excluent les brouillons et publient source, fraîcheur et fiabilité. Une valeur absente reste `null` et n'est jamais transformée en zéro.
- Un document GED n'est visible qu'après publication explicite à un client. Le téléchargement exige une version courante, propre et disponible. Les états `pending`, `quarantined`, `expired`, `replaced`, `unavailable` et `revoked` sont explicites.
- Les connexions, téléchargements, accusés, invitations, activations, suspensions, révocations et publications alimentent un audit append-only sans email brut, mot de passe, jeton, contenu documentaire ni IP brute.
- MFA est différée pour ce pilote strictement consultatif. Avant toute mutation métier, paiement ou ouverture multi-domaine, l'ADR impose WebAuthn/passkey avec TOTP de secours et une session HttpOnly/BFF.

## Fichiers modifiés

- Domaine backend : `src/module/client-portal/`.
- Montage et configuration : `src/routes/v1.routes.ts`, `src/config/app.ts`, `src/index.ts`.
- Téléchargement sûr : `src/shared/uploads/secure-download.ts` et son test de régression.
- Contrat : `src/swagger/openapi-contract.ts`, inventaire généré et rapport de couverture.
- Base : `db/patches/20260814_client_portal_sol29.sql` et scripts `preflight`, `verify`, `rollback` associés.
- E2E : `scripts/e2e/client-portal-sol29-seed.js` et adaptation du runner isolé côté frontend.
- Documentation : ADR-0075, contrat HTTP, runbook et présent rapport.

## Migration et changements de données

Le patch additif crée les comptes portail, jetons à usage unique, limites de débit, publications documentaires, accusés et audit, ainsi que les vues à projection autorisée. Un trigger refuse un accusé croisant deux clients avec `SQLSTATE 42501`. Aucune donnée client fictive n'est insérée par la migration.

Répétition PostgreSQL 16.14 jetable sur stockage `tmpfs` :

- sauvegarde : 1 968 419 octets, SHA-256 `5c6e0651dc6394966dd19f9f6a1242123f7323120fb4076d4ea8b36da37b3bf3` ;
- registre : 140 → 160 patches, aucun écart de checksum ;
- migration SOL-29 : 708 ms ; vérification : 239 ms ; rejeu : 0 patch ;
- sonde multi-client : refus vérifié dans une transaction annulée ;
- rollback : réussi en 458 ms ;
- restauration : réussie en 3 933 ms, comptages identiques et empreinte source/restaurée `225a42078d5f067edf34f7e50bc1ac7a0cfd23abf8666cbfece0d1adcb601168`.

Preuve machine : `docs/release/sol29-rehearsal/MIGRATION_REHEARSAL_SOL_06.json`.

## Tests et résultats

- backend `pnpm typecheck` : réussi ;
- backend `pnpm build` : réussi, 1 042/1 042 opérations OpenAPI inventoriées, contrat valide, 714 fichiers runtime contrôlés avant et après émission ;
- suite backend complète : exit 0 en 28,4 s ;
- suite ciblée de téléchargement sûr : 46/46 tests réussis ;
- frontend lint, typecheck et build : réussis ; build de 11 860 modules en 39,17 s ;
- suite frontend complète : 293 fichiers et 2 487 tests réussis ;
- Playwright isolé : 1 scénario métier complet réussi, 0 échec, 0 flaky ; rapport `test-results/sol-05/report.md` côté frontend ;
- répétition de migration, sauvegarde, vérification, rejeu, rollback et restauration : réussie.

## Vérification E2E

Le scénario crée deux clients indépendants et couvre : anonyme 401, admin anonyme 401, utilisateur ERP standard 403, invitation expirée, reprise après client invalide, retry idempotent, activation et connexion des deux clients, injection de `client_id` rejetée, publication GED limitée au client A, publication croisée rejetée, invisibilité côté client B, téléchargement et accusé côté client A, puis invalidation immédiate de la session après révocation.

Les traces, captures et vidéos sont configurées uniquement en cas d'échec. Le dernier passage ne produit donc aucun artefact d'échec.

## Risques et compatibilité

- La session portail reste dans un stockage navigateur distinct pour ce pilote ; l'ADR exige le passage HttpOnly/BFF avant extension de la surface sensible.
- L'envoi d'email dépend de Resend. Sans configuration valide, l'administration retourne un lien ponctuel sûr afin de permettre l'exploitation initiale sans exposer le jeton dans les logs.
- Le portail reste volontairement en lecture seule, hormis l'accusé documentaire. Aucune mutation commerciale ou financière n'est ouverte.
- Les routes ERP existantes et leurs JWT ne changent pas. Le schéma est additif.

## Rollback

Avant toute preuve portail, sauvegarder la base, arrêter les nouvelles invitations, exécuter le rollback fourni et redéployer la release précédente. Dès qu'un compte, audit, accusé ou publication existe, le rollback refuse la suppression ; le rollback opérationnel consiste alors à révoquer les comptes, retirer les publications, redéployer la release précédente et conserver les tables pour audit. Une restauration complète n'est autorisée qu'après décision d'incident et contrôle de la sauvegarde chiffrée.

## Promotion, bases et déploiements réels

### Git

- implémentation backend : `f16d090f52a86d229a85e97f2c788848c044fceb`, PR #506 vers `dev`, puis #507 vers `main` ;
- correction du gate immuable : `06094bb8101caacf27e2099c251f2a86565c579a`, PR #508 vers `dev`, puis #509 vers `main` ;
- candidat backend utilisé pour la migration et le déploiement : `304c86766057b5bb22be29df6519d9c0cf72acc2` ;
- les arbres `origin/dev` et `origin/main` ont été comparés par leur tree SHA et sont identiques ; les worktrees locaux officiels ont été avancés en fast-forward.

### Bases HYPERBOX2

Preflight réel : PostgreSQL 17.10, 154 138 291 octets et 192 clients sur `cerp_test`, 108 467 891 octets et 191 clients sur `cerp_prod`. Le volume de sauvegarde disposait de 386 643 341 312 octets libres pour un seuil calculé de 787 818 546 octets.

| Base | Sauvegarde chiffrée | Taille | SHA-256 | Catalogue |
|---|---|---:|---|---:|
| `cerp_test` | `/var/backups/cerp/cerp_test_pre_sol29_20260814-225258.dump.enc` | 73 050 480 octets | `8461469a56e454c1302ba09f95ce8a58c782685277bdeab9575e4b2c42f0d2fc` | 4 554 entrées |
| `cerp_prod` | `/var/backups/cerp/cerp_prod_pre_sol29_20260814-225258.dump.enc` | 49 577 456 octets | `27dbead9676ac996d536c151b25b07e0d7a16263ea27ea6f1ab88fa9285456ce` | 4 532 entrées |

Les clés sont séparées dans `/root/.cerp-migration-keys/sol29-20260814-225258-{test,prod}.key`, mode 600. Chaque archive a été déchiffrée en `tmpfs`, comparée à son dump source et relue par `pg_restore --list`, puis les copies en clair ont été supprimées.

Le runner a sélectionné exactement `20260814_client_portal_sol29.sql`, d'abord sur test puis sur production. Application : 1 patch par base ; rejeu : 0 ; SHA ledger `d5c203c1c44f61b2b296d8fd08a5a35eb8b65060200119cbf7fe873f215d0f5c`. Les vérifications confirment les relations, privilèges, triggers append-only, rejet multi-client et zéro compte/publication/accusé/audit initial.

La sauvegarde production a été restaurée dans `cerp_restore_verify_sol29_20260814_2258` : 106 583 731 octets, empreinte métier `6e872b29249f5e58f33b02b7756d4abc` identique à la source. La migration, sa vérification puis le rollback ont réussi sur cette restauration ; la base temporaire et le dump clair ont ensuite été supprimés.

### Services

- HYPERBOX2 : release immuable `/srv/cerp/releases/20260814-304c8676`, test et production `ready`, version complète correcte, DB/GED/antivirus/realtime `up`, routes portail et administration anonymes 401, CORS portail 204.
- Secrets test et production indépendants : `/etc/cerp/client-portal-{test,prod}.env`, root-only 600, 96 caractères mesurés sans affichage.
- Coolify : variables `CLIENT_PORTAL_JWT_SECRET` runtime-only et `CLIENT_PORTAL_PUBLIC_URL` chiffrées au repos. Rolling update `girhdqlie4pas5kttbfvow88` terminé le 14/08/2026 à 21:09:54 UTC.
- Backend public : image `rcccokw0wgcw0ck44g0wk0ck:304c86766057b5bb22be29df6519d9c0cf72acc2`, readiness 200, quatre dépendances `up`, portail/admin anonymes 401 et CORS 204.
- Frontend public : image `o00cgcso04ww0ggsgkg4wgg8:fcb96d0d234767cebb52fd424bcb9a6cef4204b5`, `/portal` 200.

La vérification Chrome du build réellement servi montre le formulaire « Accéder à mon espace », les champs email/mot de passe, la récupération, le retour collaborateurs et l'avertissement de traçabilité. URL finale `/portal/login`, titre `CERP`, zéro erreur console.

## Restant réellement à faire

Aucun développement, changement de données ou déploiement SOL-29 n'est en attente. Après le commit documentaire auto-référentiel, l'invariant final est de refaire converger `origin/main`, `health.version` et l'image Coolify sur le nouveau SHA, sans changement de comportement ni de schéma.
