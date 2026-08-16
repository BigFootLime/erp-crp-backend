# DOCS-SYNTAX-MFA — cycle de vie MFA backend

- Date : 2026-08-16 (Europe/Paris)
- Issue : `BigFootLime/erp-crp-backend#602`
- Branche : `feature/602-docs-syntax-mfa`
- Base : `origin/main` au SHA `72bfbede`

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

## Production, risques et rollback

Aucune base réelle et aucun secret runtime n’ont été modifiés pendant cette tâche. Le patch n’est pas autorisé en production par ce commit local. Pour déployer : sauvegarde vérifiée, preflight, test, verify, puis production pendant une fenêtre autorisée. Le rollback est conditionnel et refuse la perte d’une policy/libellé utile ; sinon restaurer la sauvegarde dans une base neuve et redéployer le SHA précédent.

## Reste réel

- revue puis promotion explicite via PR ;
- application contrôlée du patch sur `cerp_test`, validation opérateur, puis fenêtre `cerp_prod` ;
- vérifier deux administrateurs enrôlés et les codes hors ligne ;
- ne pas activer `required_for_all` avant communication et procédure de support utilisateur.
