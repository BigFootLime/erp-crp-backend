# SOL-29 — Portail client minimal et isolé

- Date : 2026-08-14
- Propriétaire : Keenan Martin
- Issue : `BigFootLime/crp-systems-web#704`
- Branche : `feature/704-client-portal`
- Statut fonctionnel : implémenté et validé avant promotion ; les preuves de migration et de déploiement réels seront ajoutées après promotion.

## Diagnostic et cause racine

L'ERP ne possédait pas de frontière client dédiée. Réutiliser les comptes internes, leurs JWT ou les routes ERP aurait permis une confusion de rôles et aurait fait dépendre l'isolation du navigateur. La GED ne disposait pas non plus d'une publication explicite, révocable et limitée à un client.

Pendant l'E2E réel de téléchargement, Node 24 a révélé un second défaut : la lecture d'intégrité via `for await` fermait implicitement le descripteur partagé avant la diffusion HTTP (`EBADF`). Le téléchargement est maintenant vérifié par lectures positionnelles bornées sur le même `FileHandle`, puis diffusé avec ce descripteur encore ouvert.

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

## Restant réellement à faire

- promouvoir les commits jusqu'à `dev` puis `main` dans les deux dépôts ;
- sauvegarder et appliquer le patch à `cerp_test`, puis `cerp_prod`, avec preflight, vérification et rejeu ;
- provisionner les secrets portail séparés, déployer Coolify/HYPERBOX2 et vérifier les SHA de santé ;
- exécuter la vérification navigateur post-déploiement et reporter ces preuves ici.
