# Contrat HTTP — identification industrielle SOL-30

Base : `/api/v1/traceability/identification`. Toutes les routes exigent un JWT ERP actif, passent par le gate d’accès aux modules et répondent avec `Cache-Control: private, no-store` pour les lectures sensibles.

## Capacités et étiquettes

- `GET /capabilities` : types, flux, symbologies, droits de lecture/gestion et politique hors ligne.
- `GET /labels?entity_type=&entity_id=&status=&limit=` : étiquettes que l’acteur peut lire.
- `POST /labels` avec `Idempotency-Key: <UUID>` et `{ "entity_type": "WORK_ORDER", "entity_id": "42" }` : crée l’unique étiquette active.
- `POST /labels/:id/print` avec `Idempotency-Key` et `{ "symbology": "QR_CODE", "label_profile": "STANDARD_50X30", "reason": "..." }` : rend un SVG. Le motif est obligatoire dès la réimpression.
- `POST /labels/:id/invalidate` et `POST /labels/:id/replace` exigent une clé idempotente et un motif de 3 à 500 caractères.

La gestion est autorisée uniquement si le rôle et le profil d’accès permettent le module de l’entité. Une étiquette inactive, une entité annulée ou archivée et un doublon actif sont refusés.

## Résolution et reprise hors ligne

`POST /resolve` :

```json
{
  "event_id": "22222222-2222-4222-8222-222222222222",
  "code": "CERP:1:11111111-1111-4111-8111-111111111111",
  "source": "KEYBOARD",
  "flow": "CONSUME",
  "expected_entity_types": ["STOCK_ARTICLE", "STOCK_LOT", "WORK_ORDER"],
  "client_scanned_at": "2026-08-14T10:00:00.000Z",
  "device_id": "WEB-POSTE-01"
}
```

`POST /offline/sync` accepte 1 à 50 événements. Le serveur conserve la source matérielle et l’horodatage d’origine afin qu’une réponse réseau perdue puisse être rejouée avec le même `event_id`, refuse les lectures de plus de sept jours ou une horloge en avance de plus de cinq minutes, et ne produit aucune écriture métier.

Verdicts : `RESOLVED`, `UNKNOWN`, `INVALIDATED`, `ENTITY_NOT_FOUND`, `WRONG_ENTITY_TYPE`, `FORBIDDEN_STATUS`, `INSUFFICIENT_PERMISSION`, `INVALID_PAYLOAD`, `STALE_OFFLINE_EVENT`, `FUTURE_TIMESTAMP`.

Une réponse résolue contient `requires_online_confirmation: true`, une projection minimale de l’entité et `target_route`. Les refus de permission ou d’état ne révèlent pas l’identifiant interne. Un rejeu identique indique `idempotent_replay: true`; un `event_id` réutilisé avec un contenu différent retourne un conflit.

## Flux couverts

`RECEIVE`, `PUTAWAY`, `TRANSFER`, `CONSUME`, `START_WORK_ORDER`, `QUALITY_CONTROL`, `TOOL_ISSUE`, `TOOL_RETURN`, `SHIP` et `TRACEABILITY`. Chaque flux possède une liste fermée de types acceptés. La confirmation et l’écriture restent dans le module métier ciblé.
