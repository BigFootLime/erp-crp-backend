# Temps & Déplacements — état d'avancement (checkpoint T1→T4)

Issue #119. Mode max autonome. Cible : cerp_test. Aucun cerp_prod, aucun main, aucune paie réelle touchés.
Ce document est un **checkpoint honnête**, pas un rapport de clôture : T5→T11 restent à faire.

## Statut global

| Tranche | Périmètre | État | Preuves |
|---|---|---|---|
| **T1** | Socle DB RH (15 tables `hr_*`, 17 enums, append-only, ownership) | ✅ mergé dev | migration + `db/privileged/*` (append-only + ownership), verify SQL, 9 tests |
| **T2** | Backend pointage (events append-only, badge/borne, journée/semaine, anomalies) | ✅ mergé dev | 17 tests + smoke cerp_test (idempotence 23505, UPDATE refusé, badge) |
| **T3** | Frontend salarié (pointer, relevé, anomalies) | ✅ mergé dev | typecheck/lint/build/tests verts |
| **T4** | Backend validation responsable + front responsable | ✅ mergé dev | 15 tests + smoke cerp_test (self-approve bloqué, non-replay, validation) ; 2 tests gate rôle |
| **T5** | Contrats / horaires / règles 35h–39h + admin RH | ⬜ à faire | — |
| **T6** | Kilomètres (backend + front) | ⬜ à faire | placeholder front en place |
| **T7** | Exports CSV (`;`, UTF-8 BOM) + PDF figé + checksum | ⬜ à faire | — |
| **T8** | Bornes / badges / devices CRUD + page borne (kiosk) | ⬜ à faire | backend device-events déjà là (T2) |
| **T9** | Conformité / preuves (ISO/RGPD/OWASP) | 🟡 partiel | preuves T1–T4 écrites ; registre risques à consolider |
| **T10** | Validation E2E navigateur sur cerp_test | ⬜ **bloqué** | voir « Blocages » |
| **T11** | Rapport final + gate prod | ⬜ à faire | ce checkpoint en tient lieu provisoire |

## Module utilisable ? 

- **Sur `dev` (code)** : oui pour le cœur — un salarié pointe (IN/PAUSE/RETOUR/SORTIE), voit sa journée
  et sa semaine calculées + ses anomalies ; un responsable voit l'équipe du jour et approuve/refuse les
  demandes de correction. Tout est typé, testé, mergé.
- **Sur `cerp_test` (exécutable)** : **pas encore de bout en bout** — le schéma T1 est appliqué sur
  cerp_test, mais le **backend T2+ n'y est pas déployé** (l'atelier sert le backend de prod). Il faut
  déployer le backend `dev` pointant sur cerp_test pour un test navigateur réel (T10).

## Tests verts ?

- Backend : **210 tests / 44 fichiers**, `tsc --noEmit` = 0. Smokes cerp_test T2 & T4 OK (rollback, 0 résidu).
- Frontend : **101 tests / 34 fichiers**, typecheck 0, lint 0 erreur, build OK.

## PRs (toutes mergées vers `dev`, CI verte)

- Backend : #64 (T1), T2 (mergé), #66 (T4). Frontend : #121 (T3), #122 (T4 front). Docs Phase 1 : #120.

## Prochaines étapes (ordre recommandé)

1. **T5 — règles 35h/39h configurables** (jamais en dur ; via `hr_time_rule_sets`) + contrats + admin RH.
   Débloque le calcul heures sup 25/50 % et l'attendu jour/semaine réel.
2. **T7 — exports** CSV (séparateur `;`, BOM UTF-8, pas de dépendance XLSX) + PDF figé (pdfkit) + checksum
   SHA-256 + `hr_payroll_export_batches`. Valeur RH directe (remplacer l'Excel en sortie).
3. **T6 — kilomètres** (barème configurable, pas de géoloc continue).
4. **T8 — bornes/badges** CRUD + page borne (lecteur HID clavier). Le endpoint device-events existe déjà.
5. **T10 — déploiement backend `dev`→cerp_test + E2E navigateur** (20 scénarios, seeds `TEST_TD`).
6. **T9/T11 — consolidation preuves + rapport final + plan de gate prod.**

## Petits suivis identifiés

- **Validation directe jour/semaine (UI)** : exposer l'`id` de `hr_timesheet_days` dans `GET /team/today`
  pour brancher les boutons « Valider la journée » (backend `PATCH /days/:id/validate` déjà prêt et testé).
- **Application numérique d'une correction approuvée** : aujourd'hui la décision est tracée (preuve légale) ;
  l'override du relevé (append-only ⇒ événement compensatoire ou champ override) est à définir en T5.

## Blocages

1. **T10 (E2E réel)** : nécessite de **déployer le backend `dev` sur cerp_test** (service + `.env` cerp_test).
   C'est une action d'infrastructure sur l'atelier → **à faire en validation humaine** (hors périmètre
   « code sur dev »). Sans cela, la validation navigateur reste impossible (le backend prod n'expose pas
   `/time-clock`).
2. **`users_role_check` sans `Responsable RH`** sur cerp_test (valeurs : Directeur, Employee, Administrateur
   Systeme et Reseau, Responsable Qualité, Secretaire, Responsable Programmation). Le validateur applicatif
   l'autorise mais pas la contrainte DB ⇒ on ne peut pas *créer* un `Responsable RH`. Mitigation : `Directeur`
   et `Administrateur…` sont déjà privilégiés (`isHrPrivileged`). Correctif en T5 (migration additive de la
   contrainte, ou décision d'utiliser les rôles existants). Contrôle implémenté ; preuve disponible ; écart ouvert.

## Garde-fous respectés

Aucune écriture cerp_prod ; aucun merge `main` ; aucune release ; aucun secret en clair (badge/token hachés
SHA-256, jamais loggés) ; aucune donnée test persistée (smokes en `BEGIN…ROLLBACK`) ; pas de biométrie ni de
géolocalisation continue ; aucun lien/import Excel. Formulation conformité : « contrôle implémenté / preuve
disponible / écart ouvert », jamais « certifié/conforme ISO ».
