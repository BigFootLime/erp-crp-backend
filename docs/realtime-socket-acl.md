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

Every durable payload additionally carries `event_id`, global decimal
`sequence`, `stream_id`, and `occurred_at`. The dispatcher treats multiple
targets as a set. A socket subscribed to both a module and the entity receives
one copy, not two. The 13 legacy Outillage publication sites contain IDs,
quantities, action/source and timestamps only; username/identity fields were
removed.

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

## Shared session revocation (two backend instances)

- Handshake JWT signature/expiry is verified, then status, effective roles and
  `realtime_session_epochs.session_epoch` are reloaded from shared PostgreSQL.
  A blocked, inactive, deleted, unknown, or epoch-mismatched account cannot
  connect.
- New login JWTs contain a signed random UUID `jti` and signed integer
  `session_epoch`. This removes timestamp resolution from the revocation
  decision: a mutation and a new login in the same millisecond are separated by
  the monotonically incremented database epoch.
- A timer disconnects a socket at JWT expiry; a connection cannot outlive its
  access token.
- Module/entity access is re-resolved before join and before each emission.
  Access-control mutations already invalidate the profile cache, so the next
  delivery removes a denied socket from the room.
- Database triggers increment the durable epoch in the same transaction as a
  password/role/status update, user deletion, or role-assignment mutation. The
  trigger sends a lightweight control `NOTIFY`; both backend instances
  disconnect matching sockets. A two-second database revalidation loop is the
  recovery path if a notification connection is interrupted.
- Reconnection creates no implicit business room. The frontend replays only its
  currently mounted structured subscriptions, and every replay is authorized.

Rolling compatibility is deliberate: a legacy signed JWT without the new
claims is treated as epoch zero only while the account registry is still zero.
After the first durable bump it is rejected permanently. Deployment order is:
read-only preflight, additive patch, read-only verify, compatible frontend,
then rolling backend. The patch must exist before the new backend accepts
traffic. The guarded rollback is restricted to an unused `cerp_test` install
and refuses to remove a non-empty event log.

## Durable cross-instance event transport

`public.realtime_event_log` is a retained outbox/event log shared by the two
backend processes. A producer transaction inserts one idempotent row with a
UUID event id, global `bigserial` sequence, stream, targets and JSON payload,
then sends `cerp_realtime_control` only as a wake-up hint. Audit notifications
use a deterministic deduplication key, so two listeners observing the same
PostgreSQL audit `NOTIFY` still create one event row.

- Publication retries only transient PostgreSQL failures, at most three
  attempts, with the same event id/deduplication key. A permanent or exhausted
  failure rejects the producer promise and increments/logs a privacy-safe
  failure. All 13 Outillage controllers await that promise and report failure
  through their normal error middleware.
- Every backend reads rows after its own sequence cursor in ascending order.
  `LISTEN/NOTIFY` reduces latency; one-second polling is the reliability path
  for lost notifications and listener outages. No row is destructively claimed,
  so both instances observe it.
- Local dispatch is queued per `stream_id` (entity streams for locks and entity
  changes). Different streams may progress independently. Recipient
  authorization/delivery uses isolated promises: one database/ACL/socket error
  is counted and cannot abort the other recipients or the global drain.
- A publication is successful only when PostgreSQL durably accepted it. Local
  delivery is measured separately. `deliveryBatchesWithoutRecipients` records
  the valid case where an instance has zero matching local sockets, rather than
  reporting a false delivery success.
- A reconnecting client sends its last accepted global sequence after its
  mounted descriptors have rejoined. The server replays retained rows, rechecks
  each target/recipient ACL, caps a replay at 2,000 rows per request, and returns
  a continuation cursor. Socket and browser event-id/high-water guards remove
  live/replay and duplicate-wakeup copies.
- Default retention is 24 hours (`REALTIME_EVENT_RETENTION_HOURS`) and expired
  rows are pruned in bounded batches. Retention is recovery history, not an
  authorization cache.

The only remaining process-local state is the chat presence snapshot/count,
which is explicitly a non-authoritative UI hint and is never used for access or
delivery decisions. Security revocation, event durability, ordering and replay
all use shared PostgreSQL.

The selected database/tenant is not represented by a room: production and test
are routed to separate API processes and PostgreSQL pools during the Socket.IO
handshake. Adding a tenant room inside one process would weaken that isolation.

## Observability and evidence

Counters cover denied connections/subscriptions/recipients, durable publishes,
publish retries/failures, delivered/replayed recipients, zero-local-recipient
batches, duplicate event ids, recipient isolation failures, invalid targets,
control-plane poll failures and expiry/revocation disconnects. Logs contain
event name, reason/scope, attempt/count and error class only; no user id, entity
id, token, room, payload, email, or username is logged. Station denial keeps its
pre-existing append-only audit record because user/entity identifiers are
required security evidence there.

Local proof: `src/__tests__/socket-room-acl.test.ts` starts real ephemeral
Socket.IO servers over one deterministic in-memory PostgreSQL-equivalent
control plane. Its 12 cases cover two instances, lost-NOTIFY polling,
restart/replay, lock ordering,
event/wakeup deduplication, cross-process same-millisecond revocation/new token,
legacy rollout, publish failure, zero-local delivery, recipient-error isolation,
default deny and JWT expiry. `realtime-shared-control-plane.test.ts` proves the
bounded/idempotent PostgreSQL retry contract and statically checks the patch,
read-only preflight/verify and guarded rollback;
`realtime-producer-contract.test.ts` proves awaited Outillage rejection and the
13 no-username payload sites. No script opens production,
uses a real account, executes SQL, or touches PostgreSQL.
