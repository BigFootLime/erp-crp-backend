# T8 — Bornes & badges : preuves

Objectif : provisioning des bornes/badges + page borne (kiosk). L'ingestion des événements borne
(`/device-events`, `/device-heartbeat`, `/device-config`) existe depuis T2 ; T8 ajoute le CRUD admin.
Issue #119.

## Livré (backend)

- **Bornes** (privilégié) : `POST /admin/devices` (génère un token opaque, stocke SON HASH, renvoie le
  token en clair **une seule fois**), `GET /admin/devices` (sans hash), `PATCH /admin/devices/:id/status`
  (ACTIVE/DISABLED), `POST /admin/devices/:id/rotate-token`.
- **Badges** (privilégié) : `POST /admin/badges` (uid haché SHA-256, jamais stocké/loggé en clair),
  `GET /admin/badges`, `PATCH /admin/badges/:id/revoke`.
- **Sécurité** : token/uid **hachés** (`sha256` hex) — l'empreinte TS == `encode(digest(...),'hex')` PG
  (interopérable avec la borne). Réponses/logs **sans secret ni PII sensible**.

## Tests (7 verts) — suite backend **255 / 50 fichiers**, `tsc` 0

`t8-devices.test.ts` : createDevice (token `^[0-9a-f]{48}$` renvoyé 1×, hash stocké = `hashDeviceToken(token)`,
réponse sans hash, audit sans token), salarié 403, borne inconnue 404 ; createBadge (uid haché, audit sans
uid), employé inexistant 404, salarié 403, révocation déjà faite 409.

## Smoke SQL cerp_test (BEGIN…ROLLBACK, 0 résidu)

```
1 DEVICE_AUTH: matches=1 (attendu 1 ; sha256 TS == digest PG)
2 BADGE_RESOLVE: matches=1 (attendu 1)
3 DEVICE_DISABLED: active_matches=0 (attendu 0)
4 BADGE_REVOKED: active_matches=0 (attendu 0)
```

Note : les endpoints borne sont derrière le socle `authenticateToken` (T2) ⇒ la borne s'exécute en
session kiosk authentifiée **plus** son `device_token`. Front (page borne HID + feedback vert/orange/rouge
+ gestion bornes/badges) livré séparément (T8 front).
