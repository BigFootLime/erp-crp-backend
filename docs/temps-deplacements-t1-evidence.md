# Temps & Déplacements — T1 (schéma + DB) — évidence cerp_test

> Issue frontend [#119](https://github.com/BigFootLime/crp-systems-web/issues/119) · archi + ADR-0013 dans `crp-systems-web/docs/`.
> **T1 = schéma DB + append-only + rôle RH. Aucun cerp_prod (réservé T10). Aucun code UI. Aucun lien avec d'anciens fichiers.**

## Livrables
| Fichier | Rôle |
|---|---|
| `db/patches/20260709_hr_temps_deplacements.sql` | Migration **additive idempotente** : 15 tables `hr_*` + 17 enums + FK + index + contraintes (`reason` non vide, anti auto-validation, 1 contrat actif, idempotency badge). |
| `db/privileged/20260709_hr_time_events_append_only.sql` | Hardening **append-only** de `hr_time_events` (owner→postgres, `cerp_app` INSERT/SELECT, triggers no-update/delete/truncate). Superuser only. |
| `db/privileged/20260709_hr_time_events_append_only.rollback.sql` | Rollback (restaure owner `cerp_app` + droits, retire triggers/fonction). |
| `db/privileged/20260709_hr_time_events_append_only.verify.sql` | Verify (fixture + preuves append-only + nettoyage). |
| `src/module/auth/validators/user.validator.ts` | Rôle **`Responsable RH`** ajouté (convention « Responsable X ») ; `roles` exporté. |
| `src/__tests__/temps-deplacements-t1.test.ts` | 9 tests (vocabulaire RBAC + idempotence migration + structure append-only). |

## Application sur cerp_test (2026-07-09)
Appliqué en **direct `psql` (postgres, peer auth)** — **pas** le runner (dont le `.env` pointe cerp_prod) :
1. Migration additive → cerp_test (seul NOTICE `pgcrypto already exists`).
2. Propriété : **14 tables CRUD → `cerp_app`** (owner par table) ; **`hr_time_events` → `postgres`** (append-only). Tracé dans `cerp_schema_migrations` (sha256 `2a0911ec…`).
3. Hardening append-only appliqué.

## Verify (résultat)
- owner `hr_time_events` = **postgres** · grants `cerp_app` = **INSERT,SELECT** · **3 triggers** (`no_update/no_delete/no_truncate`).
- `cerp_app` **INSERT** = SUCCESS · **UPDATE/DELETE** = *permission denied* (couche privilèges) · **owner UPDATE** = *exception append-only* (trigger backstop).
- Fixture nettoyée (`leftover = 0`).

## Tests
`tsc --noEmit` OK · vitest **178/178** (dont 9 T1) · non-régression confirmée.

## Rollback disponible
- Append-only : `db/privileged/20260709_hr_time_events_append_only.rollback.sql`.
- Schéma : additif → `DROP TABLE public.hr_* CASCADE` (base vide) ou restauration dump si nécessaire.

## Reste (hors T1)
Endpoints/services/isolation par ressource = **T2** ; front salarié = **T3** ; contrats/règles = **T5** ; km = **T6** ; exports = **T7** ; bornes/badges = **T8** ; conformité/preuves = **T9** ; prod = **T10** (backup + validation + verify).
