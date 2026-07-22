# API Parc machines — issue #165

Base : `/api/v1/production`. Toutes les routes exigent une session authentifiee et une capacite Machine. Les payloads sont Zod `strict` ; les identifiants sont des UUID opaques.

## Machines et modeles

| Methode | Route | Capacite | Objet |
| --- | --- | --- | --- |
| GET | `/machines` | `read` | Liste paginee, recherche, filtres type/statut/disponibilite/archive |
| GET | `/machines/:id` | `read` | Detail instance + modele/specs/capacites/outillages/documents |
| POST | `/machines/onboarding` | `create` | Creation transactionnelle multipart (`data`, `image?`), `Idempotency-Key` |
| PATCH | `/machines/:id/onboarding` | `update` (+ `model_update` si partage) | Edition avec `expected_updated_at`, confirmation/diff modele |
| DELETE | `/machines/:id` | `archive` | Archive logique |
| POST | `/machines/:id/reactivate` | `restore` | Reactivation avec `expected_updated_at` |
| GET | `/machine-models` / `/:id` | `read` | Catalogue et detail du modele partage |

Le client ne fournit jamais `code` ni `is_available`. Le serveur alloue `MCH-{SEQ6}` dans la transaction. Un taux horaire non nul exige source/date ; les champs de cout sont retires des DTO sans `costs`.

## Disponibilite et maintenance

| Methode | Route | Capacite | Objet |
| --- | --- | --- | --- |
| GET | `/machines/:id/context` | `read` | Disponibilite actuelle, prochaines periodes, maintenance due, charge/OF ; capacite `null` + raison si incalculable |
| GET/POST | `/machines/:id/unavailability` | `read` / `availability` | Periodes liees aux `planning_events` canoniques |
| DELETE | `/machines/:id/unavailability/:unavailabilityId` | `availability` | Archive la periode et annule/archive l'evenement Planning |
| GET/POST | `/machines/:id/maintenance/plans` | `read` / `maintenance` | Plans date/frequence/checklist |
| PATCH | `/machines/:id/maintenance/plans/:planId` | `maintenance` | Verrou `expected_updated_at`, audit before/after |
| GET/POST | `/machines/:id/maintenance/events` | `read` / `maintenance` | Historique append-only ; completion recalcule la prochaine date si possible |

Les intervalles sont `[start_ts, end_ts)`. Une fin egale au prochain debut est admise ; un chevauchement renvoie `409 MACHINE_UNAVAILABILITY_OVERLAP`.

## Documents

| Methode | Route | Capacite | Objet |
| --- | --- | --- | --- |
| GET | `/machines/:id/documents` | `read` | Metadonnees actives sans `storage_path` |
| POST | `/machines/:id/documents` | `documents` | Enregistre un lien externe source |
| POST | `/machines/:id/documents/upload` | `documents` | Multipart `data` JSON + `document`, 50 Mo maximum |
| GET | `/machines/:id/documents/:documentId/download` | `read` | Telechargement authentifie, controle horizontal, audit |
| DELETE | `/machines/:id/documents/:documentId` | `documents` | Retrait logique |

Le depot controle extension, MIME et signature, calcule SHA-256, conserve type/revision/taille/provenance et n'expose jamais le chemin interne. Formats : PDF, images, texte/CSV, bureautique et STEP/STL.

## Erreurs stables principales

- `400 INVALID_JSON`, `UNSUPPORTED_FILE_TYPE`, `UNSUPPORTED_MIME_TYPE`, `FILE_SIGNATURE_MISMATCH`
- `403 MACHINE_FORBIDDEN`
- `404 MACHINE_NOT_FOUND`, `MACHINE_DOCUMENT_NOT_FOUND`, `MACHINE_DOCUMENT_FILE_NOT_FOUND`
- `409 CONCURRENT_MODIFICATION`, `CONCURRENT_MODEL_MODIFICATION`, `IDEMPOTENCY_KEY_REUSED`, `MACHINE_UNAVAILABILITY_OVERLAP`
- `422 SHARED_MODEL_CONFIRMATION_REQUIRED`, `MACHINE_MODEL_REQUIRED_FOR_INTELLIGENCE`, `MAINTENANCE_PLAN_INVALID`

Le middleware global complete les erreurs avec le request ID selon le contrat HTTP commun.
