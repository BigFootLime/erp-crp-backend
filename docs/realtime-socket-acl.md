# Socket.IO room ACL (SEC-CERP-0004)

## Security boundary

Socket.IO is an authenticated delivery optimization, never an authorization
source. Clients send a structured subscription (`module`, `entity`, or
`station`); they never provide a room name. The server normalizes the request,
constructs its internal `rt:*` room, checks authorization before joining, and
checks the mutable account authorization again for every recipient at every
emission. Unknown modules, entity types, capabilities, shapes, and missing
access-control infrastructure are denied.

There is no `erp:global` room and no direct `io.emit`/`io.to` call outside the
ACL dispatcher.

## Event → room → capability matrix

| Event | Producers | Payload sensitivity / minimum | Internal target union | Required authorization | Consumer |
|---|---|---|---|---|---|
| `entity:changed` | Commandes clients, Livraisons, Métrologie, Qualité, Planning, Réceptions, Production | entity type/id, action, canonical module, timestamp, invalidation keys; actor removed | `rt:module:<module>` + `rt:entity:<type>:<id>` | effective account access to the canonical module | `RealtimeProvider` cache invalidation and Dashboard live-update indicator |
| `audit:new` | PostgreSQL `erp_audit_new` listener | audit UUID only | `rt:capability:audit:read` | current database `is_superadmin=true` | reserved; no active frontend consumer |
| `lock:updated` | lock acquire/heartbeat/release | exact entity and necessary lock owner display metadata | exact `rt:entity:<type>:<id>` only | effective access to the entity's mapped module | `useEntityLock` for that exact entity |
| `app-notification:created` | Commandes/Planning notifications | notification body | server-assigned `rt:user:<id>` | current active account and same user id | Notification bell |
| `chat:message:created` | Chat service | message and sender DTO | server-assigned `rt:user:<id>` | current active account and same user id | Chat widget |
| `chat:conversation:read` | Chat service | conversation id/read timestamp | server-assigned `rt:user:<id>` | current active account and same user id | Chat widget |
| `chat:conversation:upsert` | Chat service | conversation id/type/group name | server-assigned `rt:user:<id>` | current active account and same user id | Chat widget |
| `chat:presence:snapshot` | Socket connection | online user ids and timestamp | direct authenticated socket | `chat:presence` capability (all active authenticated accounts; chat is shared infrastructure) | Chat widget |
| `chat:user:presence` | first connect / last disconnect per user | user id, online flag, timestamp | `rt:capability:chat:presence` | current active account | Chat widget |
| `outilCreated`, `outilUpdated`, `outilDeleted`, `stockUpdated`, `fabricantUpdated`, `fournisseurAdded`, `fournisseurUpdated`, `revetementAdded` | legacy Outillage controllers | legacy IDs/quantities only | `rt:module:outillage` | effective account access to Outillage | compatibility events; no current repository consumer |

The dispatcher treats multiple targets as a set. A socket subscribed to both a
module and the entity receives one copy, not two.

## Entity classification

| Entity type | Module capability |
|---|---|
| `BON_LIVRAISON` | `livraisons` |
| `COMMANDE_CLIENT` | `commandes-clients` |
| `OF`, `PLANNING_EVENTS` | `production` |
| `NCR`, `CAPA`, `RECEPTION` | `qualite` |
| `METROLOGIE_EQUIPEMENT` | `metrologie` |
| `PIECE_TECHNIQUE` | `pieces-techniques` |

Adding an entity event or lock type requires adding it to this explicit map.
Same-module entities have no object-owner ACL in the current ERP model; module
access is therefore the authoritative entity scope. An exact entity room still
prevents a detail/lock event from reaching a user who did not subscribe to that
entity.

## Session, role and access changes

- Handshake JWT signature/expiry is verified, then status and effective roles
  are reloaded from PostgreSQL. A blocked, inactive, deleted, or unknown account
  cannot connect.
- A timer disconnects a socket at JWT expiry; a connection cannot outlive its
  access token.
- Module/entity access is re-resolved before join and before each emission.
  Access-control mutations already invalidate the profile cache, so the next
  delivery removes a denied socket from the room.
- Role/status changes, account deletion, and password resets disconnect local
  sockets and mark their current JWT issue time revoked for reconnection.
- Reconnection creates no implicit business room. The frontend replays only its
  currently mounted structured subscriptions, and every replay is authorized.

The revocation issue-time cutoff and online presence counters are process-local,
matching the current single Socket.IO process architecture. There is no Redis
adapter or horizontally scaled Socket.IO deployment today. Before adding one,
the cutoff/presence state must move to shared storage and the PostgreSQL audit
listener needs a cross-instance event id deduplicator; otherwise each process
would legitimately observe the same `NOTIFY`. The dispatcher intentionally does
not claim multi-instance guarantees that the current runtime does not provide.

The selected database/tenant is not represented by a room: production and test
are routed to separate API processes and PostgreSQL pools during the Socket.IO
handshake. Adding a tenant room inside one process would weaken that isolation.

## Observability and evidence

Counters cover denied connections/subscriptions/recipients, delivered
recipients, invalid emission targets, and expiry disconnects. ACL logs contain
only reason and scope; no user id, entity id, token, room, payload, email, or
username is logged. Station denial keeps its pre-existing append-only audit
record because user/entity identifiers are required security evidence there.

Local proof: `src/__tests__/socket-room-acl.test.ts` starts a real ephemeral
Socket.IO server with synthetic JWTs and authorization maps. It covers raw and
global-room rejection, negative module/entity/user joins, cross-role and
cross-entity non-delivery, union deduplication, user/audit isolation, capacity
revocation, reconnect, role change, and JWT expiry. It never opens production,
uses a real account, or touches PostgreSQL.
