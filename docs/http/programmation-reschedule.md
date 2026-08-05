# API de replanification Programmation — GPT56-FEAT-CERP-0004

Base : `/api/v1/programmations`. Toutes les routes utilisent l'authentification existante et le
contrôle compte × module Production ; le fallback de rôle reste celui du module Planning. Le
backend est la seule autorité de validation et de persistance.

## Convention temporelle

Les tâches Programmation conservent deux jours calendaires inclusifs : `start_date` et `end_date` au
format strict `YYYY-MM-DD`. Chaque intention indique un fuseau IANA, par exemple `Europe/Paris`, qui
sert à confronter ces jours aux événements `timestamptz` du planning de production. Aucune date
locale ambiguë et aucune conversion silencieuse UTC → date ne sont acceptées.

## Routes

| Méthode | Route | Effet |
| --- | --- | --- |
| `GET` | `/` | Liste enrichie avec ressources, calendrier, compétences et `version` |
| `POST` | `/:id/reschedule/preview` | Lecture seule ; calcule contraintes, alertes, suggestions et jeton |
| `POST` | `/:id/reschedule/commit` | Revalide et applique atomiquement une intention idempotente |
| `POST` | `/:id/reschedule/:operationId/cancel` | Compensation revalidée et auditée de l'opération appliquée |

## Payload de preview

```json
{
  "expected_version": 4,
  "reason": "Priorité client confirmée et capacité libérée",
  "timezone": "Europe/Paris",
  "source": "KEYBOARD",
  "candidate": {
    "start_date": "2026-08-17",
    "end_date": "2026-08-19",
    "programmer_user_id": 12,
    "machine_id": null,
    "poste_id": null,
    "calendar_id": null
  }
}
```

Une preview invalide reste `200` avec `valid=false`. Chaque violation porte `code`, `message`,
`field`, les conflits éventuels et `suggested_action`. Les créneaux proposés sont indicatifs et
portent toujours `requires_preview=true`.

## Commit

Le commit reprend le payload de preview sans aucune différence et ajoute :

```json
{
  "idempotency_key": "programmation-commit:550e8400-e29b-41d4-a716-446655440000",
  "preview_token": "<64 caractères hexadécimaux>"
}
```

La clé est bornée à 8–128 caractères. Même tâche + même clé + même charge rend l'opération existante
avec `idempotent_replay=true`. La même clé pour une autre charge rend
`409 PROGRAMMATION_IDEMPOTENCY_KEY_REUSED`.

Le service prend un verrou consultatif par intention, verrouille la tâche `FOR UPDATE`, puis prend
les verrous de ressources dans un ordre stable. Il revalide :

- version et tâche active ;
- compte programmeur actif ;
- compétences requises valides pendant toute la période ;
- poste actif et cohérent avec la machine ;
- machine disponible, planifiable et qualifiée pour la famille exigée ;
- calendrier actif, fuseau, jours ouvrés et fermetures ;
- dépendances finish-to-start et délais ;
- chevauchements programmeur, machine, poste et planning de production ;
- absence de pointage ouvert sur l'opération OF liée.

L'UPDATE vérifie encore `version = expected_version`, incrémente la version, puis la transaction
ajoute opération idempotente, événement append-only, audit, notifications et outbox. Une exception
annule tout.

## Compensation

```json
{
  "expected_version": 5,
  "reason": "Annulation compensée demandée depuis le planning",
  "timezone": "Europe/Paris",
  "source": "TOUCH",
  "idempotency_key": "programmation-cancel:550e8400-e29b-41d4-a716-446655440001"
}
```

La compensation n'est possible que si la version courante est exactement la version appliquée par
l'opération et si l'ancien état satisfait encore toutes les contraintes. Elle restaure les valeurs,
incrémente la version, marque l'opération `CANCELLED` et ajoute un événement `CANCELLED`; elle ne
supprime jamais l'événement `COMMITTED`.

## 409 actionnables

| Code | Action client |
| --- | --- |
| `PROGRAMMATION_STALE` | Recharger la tâche et refaire preview |
| `PROGRAMMATION_PREVIEW_EXPIRED` | Refaire preview avec la charge courante |
| `PROGRAMMATION_CONSTRAINT_VIOLATION` | Afficher `details.violations`, corriger, ne pas retenter |
| `PROGRAMMATION_IDEMPOTENCY_KEY_REUSED` | Nouvelle clé seulement pour une autre intention |
| `PROGRAMMATION_CANCEL_STALE` | Ne pas écraser ; nouvelle intention vers l'ancien état |
| `PROGRAMMATION_COMPENSATION_CONFLICT` | Résoudre les contraintes ou replanifier explicitement |
| `PROGRAMMATION_RESCHEDULE_ALREADY_CANCELLED` | Recharger ; aucune seconde compensation |

Les détails n'exposent ni secret ni chemin interne. Ils incluent l'état courant et une action de
reprise lorsqu'elle est sûre.

## Migration et preuves

Patch : `db/patches/20260805_programmation_safe_reschedule_0004.sql`. Supports : `.preflight.sql`,
`.verify.sql`, `.rollback.sql`. Le rollback refuse une base non dev/test/local/sandbox et toute
preuve/configuration/valeur gouvernée. La recette PostgreSQL 17 jetable couvre deux commits
concurrents, double drop idempotent, refus sans écriture partielle et compensation rejouée.
