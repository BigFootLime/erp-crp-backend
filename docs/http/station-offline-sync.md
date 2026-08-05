# Contrat UI — reprise offline station

Route : `POST /api/v1/production/station/offline/sync`. Cookie ou en-tête de session station vivant obligatoire; l'opérateur doit s'être réauthentifié.

```json
{
  "client_batch_id": "uuid",
  "events": [{
    "event_id": "uuid",
    "idempotency_key": "station:uuid",
    "type": "POINTAGE_START | POINTAGE_STOP | QUANTITY_DECLARE",
    "occurred_at": "2026-08-05T08:30:00.000Z",
    "device_id": "uuid",
    "user_id": 7,
    "station_session_id": "uuid",
    "machine_id": "uuid-ou-null",
    "payload": {}
  }]
}
```

`POINTAGE_START.payload` contient `of_id`, `activity_code`, et facultativement `operation_id`, `poste_id`, `time_type`, `comment`. `POINTAGE_STOP.payload` contient exactement `pointage_id` ou `start_event_id`. `QUANTITY_DECLARE.payload` contient `of_id`, les deltas `qty_good`, `qty_scrap`, `qty_rework`, `qty_pending_control`, et facultativement `operation_id`, `pointage_id` ou `start_event_id`, unités/motifs/note. Pour une quantité, les deux références peuvent être absentes mais jamais présentes ensemble.

Un `start_event_id` n'est résolu que vers un `POINTAGE_START` déjà synchronisé du même lot, appareil, opérateur, session source, machine et session d'exécution. Une nouvelle session vivante peut authentifier le premier traitement si cette session source historique et sa période sont encore vérifiables côté serveur. Un reçu terminal est ensuite rejoué sans revalidation volatile.

Réponse HTTP 200 :

```json
{
  "server_time": "2026-08-05T08:31:00.000Z",
  "kill_switch_enabled": false,
  "results": [{
    "event_id": "uuid",
    "status": "SYNCED | REJECTED",
    "code": "présent si rejet",
    "message": "présent si rejet",
    "server_entity_id": "présent si synchronisé",
    "replayed": false
  }]
}
```

HTTP 503 avec `kill_switch_enabled: true` et `results: []` signifie « conserver les événements locaux et réessayer plus tard ». Tout `REJECTED` est terminal et doit être affiché; un conflit ne doit jamais être remplacé automatiquement. Le client ne doit envoyer ni jeton, ni badge, ni secret dans IndexedDB ou dans `payload`.

HTTP 503 avec `OFFLINE_DEPENDENCY_MISSING`, `OFFLINE_DEPENDENCY_PENDING`, `OFFLINE_EVENT_IN_PROGRESS` ou `OFFLINE_EVENT_CLAIM_LOST` est transitoire : conserver exactement `event_id`, `idempotency_key`, `client_batch_id` et la charge, puis rejouer. Aucun reçu `REJECTED` n'est créé pour une dépendance simplement absente ou encore en cours.
