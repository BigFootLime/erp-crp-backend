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

`POINTAGE_START.payload` contient `of_id`, `activity_code`, et facultativement `operation_id`, `poste_id`, `time_type`, `comment`. `POINTAGE_STOP.payload` contient exactement `pointage_id` ou `start_event_id`. `QUANTITY_DECLARE.payload` contient `of_id`, les deltas `qty_good`, `qty_scrap`, `qty_rework`, `qty_pending_control`, et facultativement `operation_id`, `pointage_id` ou `pointage_start_event_id`, unités/motifs/note.

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
