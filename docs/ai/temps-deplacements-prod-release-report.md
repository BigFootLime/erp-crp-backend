# Temps & Déplacements — Rapport de gate prod

Issue #119. Date : 2026-07-10. Passage dev/cerp_test → main/cerp_prod, **en cours, ARRÊTÉ au gate merge/déploiement**.
Aucun secret dans ce document. Le module DB est en prod ; l'application n'est **pas** encore déployée.

## 1. Recette navigateur cerp_test

**Non exécutée** (bloquée) : le backend T2+ n'est pas déployé sur cerp_test, et je ne peux ni déployer
(secret DB `cerp_app`) ni me connecter (saisie de mot de passe interdite). **À la place**, la chaîne
complète a été validée au niveau **service/DB** sur cerp_test (`BEGIN…ROLLBACK`, 0 résidu) :
pointage→420 min, correction approuvée par un tiers, validation jour/semaine, km soumis→validés, export,
auth borne + résolution badge — plus les smokes par tranche (T2/T4/T5/T6/T7/T8). Preuves : `docs/temps-deplacements-t*-evidence.md`.

## 2. Backup cerp_prod

- Fait **avant** toute migration. `pg_dump -Fc` → `/var/backups/cerp/cerp_prod_td_gate_20260710-083938.dump` (~848 Ko).
- Vérifié : `pg_restore --list` = 1960 objets (archive valide/restaurable). Aucun secret affiché.

## 3. Migrations appliquées sur cerp_prod (as postgres, `ON_ERROR_STOP=1`)

Ordre strict, additif, idempotent :
1. `db/patches/20260709_hr_temps_deplacements.sql` — 15 tables `hr_*`, 17 enums, contraintes, index.
2. `db/privileged/20260709_hr_module_ownership.sql` — 14 tables CRUD → `cerp_app`.
3. `db/privileged/20260709_hr_time_events_append_only.sql` — append-only (owner postgres, cerp_app INSERT/SELECT, 3 triggers).
4. `db/patches/20260710_hr_users_role_responsable_rh.sql` — `users_role_check` + `Responsable RH`.

Résultat : `PSQL_EXIT=0`. Aucune donnée existante modifiée (prod était vierge de `hr_*`).

## 4. Verify SQL prod (prod-safe, sans insertion de ligne de test)

```
1. tables hr_ = 15
2. propriété : cerp_app=14, postgres=1
3. hr_time_events : owner=postgres ; cerp_app INSERT=t SELECT=t UPDATE=f DELETE=f
4. triggers append-only = 3
5. users_role_check ⊇ 'Responsable RH' = t
6. contrainte no-self-approve = présente
7. index unique idempotency_key = présent
8. cerp_app écrit CRUD (hr_employees INSERT, hr_kilometer_entries UPDATE) = t,t
9. index « 1 contrat actif / employé » = présent
```

## 5. PRs dev → main

**Non ouvertes** (arrêt volontaire au gate). Backend dev **+19** commits d'avance sur main ; frontend **+16**.
Le garde de visibilité pilote (front #128) est mergé sur dev, prêt à partir dans le merge main.

## 6. CI / 7. Déploiement

**N/A** — non déployé. Le backend/frontend de prod ne servent pas encore `/time-clock`.

## 8. Vérification prod

- **DB** : migrée + vérifiée (§4).
- **Application** : non déployée → endpoints `/time-clock` pas encore exposés en prod (attendu).

## 9. Rôles activés

- **Garde front pilote** en place : menu visible seulement pour RH / Direction / Admin (front #128).
- **Backend** : socle `authenticateToken` + RBAC (admin/responsable privilégiés ; salarié = ses données).
- **Provisioning `Responsable RH`** : la contrainte DB l'autorise désormais ; **création des comptes = à faire** (gate).

## 10. Données pilote / 11. Données test

**Aucune** donnée pilote ni test créée en prod (0 ligne `hr_*` insérée). Verify 100 % introspection.
Si un pilote est lancé, nommer les jeux `PILOT_TD` / `TEST_TD_PROD` et supprimer les tests.

## 12. Risques restants

EC-01 recette navigateur + déploiement (gate) · EC-02 rétention RGPD (manuelle) · EC-04 override numérique
d'une correction approuvée · exposition prod tant que non déployé = nulle. `hr_time_events` immuable
(append-only) dès maintenant.

## 13. Rollback

- **DB** : `db/privileged/*.rollback.sql` (append-only, ownership) + `DROP` des tables `hr_*` si besoin
  (tables vides ⇒ aucune perte). Restauration complète possible depuis le dump du §2.
- **users_role_check** : réversible (ré-appliquer l'ancienne définition sans `Responsable RH`).
- **App** : non déployée ⇒ rien à annuler côté service.

## 14. Verdict

- **Module en prod** : **DB oui**, **application non** (pas déployée).
- **Accès limité** : **oui** (garde front pilote + RBAC backend + socle).
- **Prêt pilote** : **pas encore** — reste (gate humain) : (a) déployer backend sur cerp_test + recette
  navigateur, (b) PR dev→main (back+front) + CI verte + déploiement, (c) créer les comptes `Responsable RH`
  / valider les managers, (d) recette prod (20 scénarios), puis ouverture pilote restreinte.

**Arrêt ici** conformément à la règle « ne touche pas main / pas de déploiement sans validation ».
