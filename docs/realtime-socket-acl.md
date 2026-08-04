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
| `entity:changed` | Commandes clients, Livraisons, Métrologie, Qualité, Planning, Réceptions, Production, Outillage | entity type/id, action, canonical module, timestamp, invalidation keys; actor removed | `rt:module:<module>` + `rt:entity:<type>:<id>` | effective account access to the canonical module | `RealtimeProvider` cache invalidation and Dashboard live-update indicator |
| `audit:new` | audit repository; mandatory privileged audit trigger covers non-application writers | audit UUID only | `rt:capability:audit:read` | current database `is_superadmin=true` | reserved; no active frontend consumer |
| `lock:updated` | lock acquire/heartbeat/release and server expiry sweep | exact entity and necessary lock owner display metadata; expiry/release sends `lock:null` | exact `rt:entity:<type>:<id>` only | effective access to the entity's mapped module | `useEntityLock` for that exact entity |
| `app-notification:created` | Commandes/Planning notifications | notification body | server-assigned `rt:user:<id>` | current active account and same user id | Notification bell |
| `chat:message:created` | Chat service | message and sender DTO | server-assigned `rt:user:<id>` | current active account and same user id | Chat widget |
| `chat:conversation:read` | Chat service | conversation id/read timestamp | server-assigned `rt:user:<id>` | current active account and same user id | Chat widget |
| `chat:conversation:upsert` | Chat service | conversation id/type/group name | server-assigned `rt:user:<id>` | current active account and same user id | Chat widget |
| `chat:presence:snapshot` | Socket connection | online user ids and timestamp | direct authenticated socket | `chat:presence` capability (all active authenticated accounts; chat is shared infrastructure) | Chat widget |
| `chat:user:presence` | first connect / last disconnect per user | user id, online flag, timestamp | `rt:capability:chat:presence` | current active account | Chat widget |

Every durable payload additionally carries `event_id`, global decimal
`sequence`, `stream_id`, and `occurred_at`. The dispatcher treats multiple
targets as a set. A socket subscribed to both a module and the entity receives
one copy, not two. These four metadata fields are mandatory: the frontend
rejects metadata-free or partial durable events. Presence is the only
metadata-free Socket payload family and is explicitly ephemeral, outside the
durable replay protocol.

## Historical Outillage event inventory (removed)

The review prompt expected nine historical names. A source inventory found
exactly **eight unique names** across **13 producer call sites**. All 13 sites
now enqueue the canonical `entity:changed` contract transactionally. None of
the names below is published, accepted, dispatched, or retained as a runtime
compatibility alias.

| Historical name | Former domain | Current contract |
|---|---|---|
| `outilCreated` | Outil | removed → `entity:changed` |
| `outilUpdated` | Outil | removed → `entity:changed` |
| `outilDeleted` | Outil | removed → `entity:changed` |
| `stockUpdated` | Stock Outillage | removed → `entity:changed` |
| `fabricantUpdated` | Fabricant | removed → `entity:changed` |
| `fournisseurAdded` | Fournisseur | removed → `entity:changed` |
| `fournisseurUpdated` | Fournisseur | removed → `entity:changed` |
| `revetementAdded` | Revêtement | removed → `entity:changed` |

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
- Application repositories increment the durable epoch in the same transaction as a
  password/role/status update, user deletion, or role-assignment mutation. The
  transaction sends a lightweight control `NOTIFY`; both backend instances
  disconnect matching sockets. Mandatory privileged triggers cover writers
  outside the application. A two-second database revalidation loop is the
  recovery path if a notification connection is interrupted.
- Every durable dispatch performs a fresh privileged-backstop check. Missing
  or unverifiable trigger/function bindings atomically suspend readiness,
  invalidate authorization caches and disconnect every already-authorized
  socket. Recovery bumps every account session epoch and the shared
  authorization epoch before readiness is restored, so only a new login,
  room join and replay can resume delivery.
- Reconnection creates no implicit business room. The frontend replays only its
  currently mounted structured subscriptions, and every replay is authorized.
- Public reset requests send email only after the reset-token transaction has
  returned a COMMIT acknowledgement or exact committed-state proof. Admin reset
  keeps its existing token UI/API contract, but password update, token
  consumption and session-epoch bump are one locked/reconciled transaction.
  Local socket disconnection runs after that proof and is best-effort; it never
  starts a second durable revocation or turns a committed reset into an error.

Rolling compatibility is deliberate: a legacy signed JWT without the new
claims is treated as epoch zero only while the account registry is still zero.
After the first durable bump it is rejected permanently. The v2 sequence
allocator is intentionally not rolling-compatible with v1 `bigserial`: drain
and stop v1 writers, run the read-only preflight, apply v2, run both runtime and
privileged verifies, then start the compatible backend/frontend. An applied-v1
upgrade installs a replay barrier above every sequence v1 could have issued.
The guarded rollback is restricted to an unused `cerp_test` install and refuses
to remove mutated durable state.

## Durable cross-instance event transport

Business repositories write deterministic `REALTIME.DISPATCH` envelopes to
`public.erp_outbox_events` in the same transaction as the business mutation.
The shared dispatcher validates and promotes each envelope into
`public.realtime_event_log`. Its singleton allocator assigns a global sequence
while holding one transactional row lock, so visible sequence order is commit
order rather than `bigserial` allocation order. `pg_notify` is only a wake-up
hint; polling is the reliability path.

- Repository producers use a stable mutation key. Repeating the same key and
  exact input is idempotent; the same key with different input fails with
  `REALTIME_OUTBOX_KEY_COLLISION`. Business data and its outbox envelope commit
  together. Lost COMMIT acknowledgements are reconciled from exact event-key
  and business-state evidence on a fresh connection; partial or contradictory
  evidence returns a retry-safe 503 instead of guessing.
- Every backend reads rows after its own sequence cursor in ascending order.
  `LISTEN/NOTIFY` reduces latency; one-second polling is the reliability path
  for lost notifications and listener outages. No row is destructively claimed,
  so both instances observe it.
- Local dispatch is queued per `stream_id` and the global durable cursor advances
  only after the next sequence has been fully evaluated. Recipient
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
- First-session bootstrap and too-old/future cursors require a full projection
  refetch before the browser persists the returned watermark. Any malformed
  stored event/target aborts replay/bootstrap; it is never skipped or made
  ACKable. Invalid outbox envelopes are quarantined as non-published failures.
- Default retention is 24 hours (`REALTIME_EVENT_RETENTION_HOURS`) and expired
  rows are pruned in bounded batches. Retention is recovery history, not an
  authorization cache.

Chat presence is a non-authoritative UI hint, but its leases are shared in
`public.realtime_chat_presence`. First-online/last-offline transitions use
per-user advisory locks; heartbeat and bounded expiry sweeps prevent a crashed
instance from leaving a ghost user online. Presence snapshots are returned in
bootstrap/full-resync ACKs and applied only after projection refetch. Presence
is never used for access or durable delivery decisions.

Expired edit locks also have a server-owned path: every instance claims bounded
rows with `FOR UPDATE SKIP LOCKED`, deletes them, and enqueues the matching
`lock:updated { locked:false }` event in the same transaction. Client retry is
only a latency fallback, not the expiry mechanism.

The mandatory privileged deployment step pins its three `SECURITY DEFINER`
functions to owner `postgres`, `search_path=pg_catalog`, owner-only EXECUTE ACLs
and exact verified bodies. Readiness is degraded if any function or trigger
binding differs. The runtime role remains `cerp_app`; the privileged verify is
read-only and checks that role explicitly. Deployment must run the privileged
installer and verifier as a superuser before starting CERP. In the deployed
topology that owner is the documented local-socket `postgres` superuser on
HYPERBOX2; the VPS hosts no database and reaches the same HYPERBOX2 PostgreSQL
instance, so privileged installation is executed once at that database owner
boundary rather than inside the VPS application container.

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

Local proof includes real ephemeral Socket.IO servers for ACL, concurrent room
limits, two-instance delivery/revocation, replay/bootstrap/future cursors,
invalid-target non-ACK, presence restoration and JWT expiry. Focused control
plane tests cover commit ordering, retention integrity, outbox collision and
quarantine, privileged SQL contracts and COMMIT-ACK reconciliation. Module
route/producer tests cover Commandes, Livraisons, Métrologie, Planning,
Production, Qualité, Réceptions and Outillage. Lock tests prove
DELETE → unlock outbox → COMMIT ordering. No proof script opens production or
uses a real account.
