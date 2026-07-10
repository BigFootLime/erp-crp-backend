# Temps & Déplacements — Rapport de release main/prod (pilote)

Issue #119. Date : 2026-07-10. Gate main/prod **exécuté et terminé**. Aucun secret dans ce document.

## 1. Décision de déploiement sans recette navigateur complète

Le responsable projet a explicitement décidé de **déployer sans la recette navigateur UI complète**,
la recette étant impossible pour l'agent (déploiement cerp_test = secret DB `cerp_app` + infra ;
login = saisie de mot de passe interdite).

## 2. Risque accepté par le responsable projet

Risque résiduel accepté : **pas de recette UI bout-en-bout**. Validation retenue jugée suffisante pour un
passage **pilote** : tests unitaires (255 backend / 107 frontend), typecheck, lint, build, **smokes SQL
cerp_test** (dont chaîne E2E complète, 0 résidu) et validations service/DB.

## 3. Backup cerp_prod

- Frais, avant tout : `/var/backups/cerp/cerp_prod_main_release_20260710-090525.dump` (~894 Ko).
- Vérifié `pg_restore --list` = 2065 objets (archive valide). (Backup antérieur pré-migration conservé aussi.)

## 4. Vérification cerp_test

Tout vert : 15 tables `hr_*`, 16 enums, propriété cerp_app=14/postgres=1, append-only (owner postgres ;
cerp_app INSERT/SELECT, **UPDATE/DELETE refusés** ; 3 triggers), Responsable RH autorisé, no-self-approve,
idempotency unique, km/exports/devices/badges + grants, **0 donnée TEST/PILOT/SMOKE**.

## 5. Vérification cerp_prod

**Identique à cerp_test** (mêmes contrôles, tous verts). Confirmé migrée + cohérente.

## 6. Migrations appliquées ou déjà présentes

`cerp_prod` **déjà migrée** (tour précédent, backup préalable) : `20260709_hr_temps_deplacements.sql`,
`hr_module_ownership`, `hr_time_events_append_only`, `20260710_hr_users_role_responsable_rh.sql`.
Ce tour : **aucune réapplication** (verify only). `cerp_test` : déjà complète, rien à appliquer.

## 7. PR backend dev → main

[#74](https://github.com/BigFootLime/erp-crp-backend/pull/74) — 19 commits 100 % #119 (+ 2 points
d'intégration : `user.validator` rôle RH, `v1.routes` montage `/time-clock`). CI verte. **Mergé** → main `db3a719`.

## 8. PR frontend dev → main

[#129](https://github.com/BigFootLime/crp-systems-web/pull/129) — 16 commits 100 % #119 (+ Dashboard/
lazy-pages/nav-erp, garde pilote, ADR/archi). CI verte. **Mergé** → main `7b387da`.

## 9. CI

Backend : « Backend CI (quality gate) » ✅. Frontend : Frontend CI + governance + changelog +
dependency-review + docs-check ✅.

## 10. Déploiement

**Automatique sur push `main`** (workflows `deploy.yml`) :
- Backend « 🚀 Deploy ERP Backend to VPS » ✅ success.
- Frontend « 🚀 Deploy Frontend to Debian » ✅ success.

## 11. Smoke prod (sans login UI)

Backend `https://erp-backend.croix-rousse-precision.fr` :
```
/api/v1                              200
/api/v1/environment                  200  {"database":"cerp_prod","environment":"production", ...}
/api/v1/clients            (no token) 401
/api/v1/time-clock/me/today (no token) 401   (route montée + protégée)
/api/v1/time-clock/team/today          401
/api/v1/time-clock/admin/rule-sets     401
```
Frontend `https://cerp.croix-rousse-precision.fr` : **200**, index HTML + assets servis.
BDD `cerp_prod` : toutes tables `hr_*` interrogeables, **tous compteurs = 0** (aucun seed/donnée test).

## 12. État final

- Backend main **déployé** (VPS). Frontend main **déployé** (Debian). `cerp_prod` **pointée** (env=cerp_prod).
- Module `/time-clock` **live et protégé** (401 sans token). Aucune donnée pilote/test en prod.

## 13. Risques restants

- **Recette navigateur UI** non faite (risque accepté) — à dérouler au lancement pilote.
- **Provisioning** : créer les comptes `Responsable RH` / valider les managers, puis saisir le référentiel
  (règles, contrats, horaires, véhicules, bornes+jetons, badges) avant usage réel.
- `appEnv:"development"` sur cerp_prod = **réglage préexistant** (hors #119), à corriger séparément.
- EC-02 rétention RGPD (manuelle) ; EC-04 override numérique d'une correction approuvée.

## 14. Rollback possible

- **App** : redéploiement du commit `main` précédent (backend `345212a`, frontend `666881e`) via le pipeline.
- **DB** : tables `hr_*` **vides** ⇒ `db/privileged/*.rollback.sql` (append-only, ownership) + DROP `hr_*`
  sans perte ; ou restauration `cerp_prod_main_release_20260710-090525.dump`. `users_role_check` réversible.

## 15. Prochaines actions

1. Provisionner comptes `Responsable RH` + managers ; saisir le référentiel.
2. Recette navigateur pilote (20 scénarios, `docs/temps-deplacements-t10-e2e-plan.md`) sur un périmètre restreint.
3. Planifier la rétention RGPD (EC-02). Corriger `appEnv` prod (hors #119).
4. Révoquer/changer les accès temporaires partagés en chat.

## Verdict

- Backend main déployé : **OUI**
- Frontend main déployé : **OUI**
- cerp_test à jour : **OUI**
- cerp_prod à jour : **OUI**
- Module Temps & Déplacements en prod : **OUI** (pilote, accès maîtrisé : garde front + RBAC backend)
- Smoke prod vert : **OUI**
