# DOCS-SYNTAX-MFA — cycle de vie MFA backend

- Date : 2026-08-17 (Europe/Paris)
- Issue : `BigFootLime/erp-crp-backend#602`
- Branche source : `feature/602-docs-syntax-mfa` (`92f0915`)
- Promotion : PR `#603` vers `dev` (`661a0afc`), puis PR `#604` vers `main` (`1bb97013`)

## Diagnostic et cause racine

Le socle SOL-32 protégeait les comptes privilégiés, mais la politique restait codée dans le rôle superadministrateur. Un compte standard ne pouvait pas s’enrôler volontairement, le facteur ne portait aucun nom d’appareil et l’administrateur ne disposait d’aucun contrat API pour piloter la politique par base. Le frontend seul ne pouvait pas corriger ces lacunes sans créer un contournement de sécurité.

## Architecture

La règle devient un domaine serveur testable. La policy est persistée dans `erp_settings`, donc isolée entre `cerp_test` et `cerp_prod`, avec la valeur conservatrice `required_for_admins`. Un facteur actif reste toujours exigé. Les routes d’enrôlement et de policy utilisent l’authentification existante, le RBAC live, le rate limiting, la validation, les confirmations mot de passe/MFA et l’audit.

## Fichiers et données

- domaine : `src/module/auth/domain/mfa-policy.ts` ;
- service, controller, repository, routes et validators MFA ;
- migration additive `20260816_mfa_policy_and_device_labels.sql` ;
- preflight, verify et rollback associés ;
- tests de domaine, routes/RBAC et garde de migration ;
- inventaire et couverture OpenAPI régénérés ;
- maintenance périodique des challenges et facteurs provisoires expirés.

La migration ajoute `user_mfa_factors.device_label` avec contrainte 1–80 caractères et insère `security.mfa_policy` de manière idempotente. Elle ne crée aucun facteur et ne modifie aucun secret.

## Tests et migration isolée

- tests MFA ciblés : 7 fichiers, 35 tests réussis ;
- suite backend complète : sortie 0 ;
- typecheck : réussi ;
- build/OpenAPI : réussi, 1 077 opérations, couverture 100 % ;
- répétition SQL jetable : 140 → 166 patches, 26 appliqués, rejeu 0, vérification, rollback et restauration réussis ;
- empreinte source/restaurée identique : `c4c25532a08e296463292b9e2a198e53841b66a13ea41caaa6e24d0755834e3b` ;
- rapport : `docs/release/docs-mfa-rehearsal/MIGRATION_REHEARSAL_SOL_06.md`.

## Migration et déploiement vérifiés

- `cerp_test` : sauvegarde `/var/backups/cerp/cerp_test_docs_mfa_20260817-0112.dump`, 75 649 385 octets, SHA-256 `6808d8e468cb10d3445e6a9668a0552c78d628160266fc333b45cd74e73088ed` ; preflight, application transactionnelle et verify réussis.
- `cerp_prod` : sauvegarde `/var/backups/cerp/cerp_prod_20260817-011425.dump`, 52 138 561 octets, SHA-256 `2afe4c1bd63ae819282f8a95472f1a9588979ee50950f5b4237b3493443869a3` ; preflight, application transactionnelle et verify réussis.
- Les deux bases déclarent `security.mfa_policy=required_for_admins`, un facteur actif et aucun enrôlement provisoire expiré.
- HYPERBOX2 : releases immuables test et production, services `cerp-api-test` et `cerp-api` prêts ; DB, GED, antivirus et temps réel déclarés opérationnels.
- Coolify/VPS : conteneur production sain et endpoints `/health/live` et `/health/ready` HTTP 200, avec la version `1bb970133685fc94659f89aa73bc3f5e09e4dcf6`.

## Production, risques et rollback

La fenêtre de production a été explicitement autorisée par Keenan Martin. Le patch additif est appliqué et enregistré sur `cerp_test` et `cerp_prod`. Le rollback SQL est conditionnel et refuse la perte d'une policy ou d'un libellé utile ; dans ce cas, restaurer la sauvegarde vérifiée dans une base neuve, valider son intégrité puis redéployer le SHA précédent. Les anciens checkouts HYPERBOX2, y compris leurs modifications locales, n'ont pas été écrasés : le déploiement utilise des répertoires de release immuables et des overrides systemd.

## Reste réel

- vérifier deux administrateurs enrôlés et la conservation de leurs codes hors ligne ;
- ne pas activer `required_for_all` avant communication et procédure de support utilisateur.
