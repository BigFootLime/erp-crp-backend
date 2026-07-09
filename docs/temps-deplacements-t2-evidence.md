# Temps & Déplacements — T2 (backend pointage) — évidence cerp_test

> Issue [#119](https://github.com/BigFootLime/crp-systems-web/issues/119) · s'appuie sur le schéma T1 (aucune nouvelle migration).
> **cerp_test uniquement. Aucun front, aucune borne matérielle, aucun cerp_prod, aucun main.**

## Module `src/module/temps-deplacements/` (quartet)
`types/` · `validators/` (Zod, parse contrôleur) · `repository/` (SQL + transactions + audit) · `services/` (logique) · `controllers/` · `routes/`. Monté après le socle `authenticateToken` (`v1.routes.ts`) → **JWT d'office**.

## Endpoints
| Endpoint | Accès |
|---|---|
| `POST /time-clock/events` | salarié (employé dérivé de `req.user` — **aucun employee_id en entrée**) |
| `GET /time-clock/me/today` · `/me/week` · `/me/anomalies` | salarié (ses données) |
| `GET /time-clock/employees/:id/today` · `/:id/week` | **soi / manager / RH-Direction-Admin** (anti-IDOR) |
| `POST /time-clock/device-events` · `/device-heartbeat` · `GET /device-config` | JWT socle **+ device_token haché** |

## Règles implémentées
- `hr_time_events` **append-only** (aucun UPDATE/DELETE ; corrections → `hr_time_adjustments`, T4).
- **idempotency_key obligatoire** pour device-events (contrainte unique → dé-doublonnage).
- **badge_uid & device_token hachés** (sha256), jamais stockés/loggés en clair.
- **double badge** rapproché (même type < 90 s) détecté → anomalie `DOUBLE_BADGE`, pas de doublon.
- **badge inconnu → 404**, **badge révoqué → 403** : traités comme **événements refusés + audités** (décision : pas de ligne `hr_time_anomalies`, un badge inconnu n'a pas d'employé). *(les enums `UNKNOWN_BADGE`/`REVOKED_BADGE` évoqués sont couverts par ce chemin refus+audit.)*
- **Audit** sur toutes les écritures (`temps-deplacements.event.create_web/create_badge/double_badge_*/refused`, `.device.heartbeat`) — **jamais** de badge_uid/token/payload sensible dans les détails.
- Réponse borne : aucune donnée RH sensible.
- **Calcul journée** (moteur pur `summarizeDay`) : première IN, dernière OUT, pauses, temps travaillé ; attendu **depuis le contrat** (`repoGetDailyTargetMinutes` — jamais 35/39 en dur) ; heures sup / manquantes ; anomalies structurelles (`MISSING_IN/OUT/BREAK_END`, `TOO_LONG_DAY`, `TOO_SHORT_BREAK`). `MISSING_OUT`/`MISSING_BREAK_END` seulement sur jour passé (session en cours = normale aujourd'hui).

## Tests
- **17 tests unitaires** (`src/__tests__/temps-deplacements-t2.test.ts`) : `summarizeDay` (IN/OUT, pause complète/incomplète, entrée sans sortie), `detectTimeAnomalies`, hachage badge/token (jamais en clair), validateurs (anti-IDOR structurel, idempotency), RBAC (salarié↔autre = 403, manager, RH). **Suite : 43 fichiers / 195 verts. Typecheck OK.**
- **Smoke SQL cerp_test** (couche repository) : insert `cerp_app` OK ; idempotency doublon → 23505 ; UPDATE `hr_time_events` → *permission denied* ; badge actif/révoqué/inconnu ; requête jour ; cleanup `leftover=0`.

## Reste (hors T2)
Front salarié = T3 · validation responsable + corrections = T4 · contrats/règles UI = T5 · km = T6 · exports = T7 · bornes/badges CRUD + kiosk = T8.
