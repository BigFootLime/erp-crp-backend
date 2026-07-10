# Temps & Déplacements — Rapport final (T1→T11)

Issue #119. Mode max autonome. Cible **cerp_test**. **Aucun `cerp_prod`, aucun `main`, aucune release,
aucune paie réelle** touchés. Module construit en tranches testées, chacune mergée vers `dev` avec CI verte.

## 1. Statut global

| Tranche | Livré | PRs |
|---|---|---|
| **T1** socle DB (15 tables `hr_*`, append-only, ownership) | ✅ | back #64 |
| **T2** backend pointage (append-only, badge/borne, journée/semaine, anomalies) | ✅ | back (mergé) |
| **T3** frontend salarié (pointer, relevé, anomalies) | ✅ | front #121 |
| **T4** validation responsable (corrections tracées, validation, périmètre) | ✅ | back #66, front #122 |
| **T5** contrats/horaires/règles 35h-39h configurables + admin RH | ✅ | back #68, front #123 |
| **T6** kilomètres (déclaration + validation) | ✅ | back #70, front #125 |
| **T7** exports CSV/PDF figés + checksum | ✅ | back #69, front #124 |
| **T8** bornes/badges + page borne (kiosk HID) | ✅ | back #71, front #126 |
| **T9** conformité/preuves + registre risques | ✅ | front #127 |
| **T10** E2E : **chaîne service/DB validée** ; navigateur **gated** (déploiement) | 🟡 | ce dossier + seeds |
| **T11** rapport final + gate prod | ✅ | ce document |

## 2. Module utilisable ?

- **Côté code (`dev`)** : **oui, complet** — un salarié pointe (web/borne), voit journée/semaine calculées
  avec règles réelles (35/39/partiel, HS 25/50), déclare ses km ; un responsable valide corrections,
  jours/semaines et km, administre règles/contrats/horaires/bornes/badges, génère des exports paie figés.
- **Exécutable navigateur sur `cerp_test`** : **en attente** du déploiement backend (T10, gate humain).
  Toute la chaîne est validée au niveau service/DB par smokes `BEGIN…ROLLBACK` (0 résidu).

## 3. Tests

- **Backend** : 255 tests / 50 fichiers, `tsc --noEmit` = 0.
- **Frontend** : 105 tests / 36 fichiers, typecheck 0, lint 0 erreur, build OK.
- **Smokes cerp_test** : T2, T4, T5, T6, T7, T8 + **chaîne complète T10** — tous verts, 0 donnée persistée.

## 4. Conformité (audit interne, sans prétention ISO)

Dossier `crp-systems-web/compliance/iso27001/evidence/time-clock-module.md` + `…-risk-register.md`.
Contrôles implémentés (preuve disponible) : append-only, anti-IDOR, séparation des tâches (no self-approve),
hachage secrets (badge/token SHA-256, jamais loggés), audit systématique, intégrité export (checksum),
minimisation RGPD (pas de biométrie ni géoloc continue), règles configurables (aucun 35/39 en dur), socle
default-deny. Écarts ouverts EC-01…EC-05 tracés.

## 5. Gate prod (validation humaine requise — NON exécuté par l'agent)

À dérouler, dans l'ordre, sous validation du propriétaire, avec backup préalable :

1. **Migrations prod** (`db/patches/20260709_hr_temps_deplacements.sql`, `20260710_hr_users_role_responsable_rh.sql`)
   appliquées sur `cerp_prod` **après backup**, en direct psql (pas le runner), avec verify.
2. **Hardening append-only prod** : `db/privileged/20260709_hr_time_events_append_only.*` +
   `20260709_hr_module_ownership.*` sur `cerp_prod` (superuser, backup préalable, verify).
3. **Déploiement backend** (image `dev`→release) exposant `/time-clock/*` en prod.
4. **Provisioning rôles** : créer les comptes `Responsable RH` / valider les managers (`manager_user_id`).
5. **Données de référence** : règles de calcul réelles (35h/39h/partiel), contrats, horaires, véhicules,
   bornes (jetons distribués), badges.
6. **Recette navigateur** prod (20 scénarios T10) + revue des logs d'audit.
7. **Purge/rétention** RGPD (EC-02) : planifier le job (aujourd'hui manuel DBA).

## 6. Écarts ouverts (rappel)

EC-01 E2E navigateur (déploiement) · EC-02 rétention automatisée · EC-03 append-only prod ·
EC-04 application numérique d'une correction approuvée · EC-05 filtrage nav par rôle.

## 7. Garde-fous respectés

Aucune écriture `cerp_prod` ; aucun merge `main` ; aucune release ; aucun secret en clair (hachage
SHA-256, jetons renvoyés 1×, jamais loggés) ; aucune donnée test persistée (smokes en `ROLLBACK`) ; pas de
biométrie ni géolocalisation continue ; aucun lien/import Excel (exports maison CSV/PDF). Conformité
formulée « contrôle implémenté / preuve disponible / écart ouvert ».

## Prochaine action recommandée

Exécuter le **gate prod** (§5) sous validation humaine, en commençant par le déploiement backend sur
cerp_test pour lever EC-01 et dérouler la recette navigateur (T10).
