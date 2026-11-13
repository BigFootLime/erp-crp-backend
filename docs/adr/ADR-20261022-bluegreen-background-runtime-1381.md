# Background execution during an API/UI blue-green release (#1381)

Status: proposed; isolated implementation, not production activation.

## Context

The API entry point starts twelve recurring maintenance tasks. Running another
API container for a traffic switch must not start a second set of those tasks.
Cancelling a timer alone also does not finish a cycle already processing work.
The shared Directory remains the authority for credentials, PIN and MFA.

## Decision

`CERP_BACKGROUND_WORKERS` selects one of three explicit modes:

| Mode | Intended process | Recurring maintenance |
| --- | --- | --- |
| `always` | Existing combined installation, compatibility default | Starts the twelve tasks |
| `off` | Each routed blue/green API | Starts no recurring task or leadership connection |
| `leader` | Dedicated non-routed process, with its normal API/Socket listener forced to `127.0.0.1` | Starts tasks only while owning the PostgreSQL session lock |

`CERP_STANDBY=true` maps to `off`. Combining standby with an explicit leader
request is rejected. Unknown modes fail startup. These settings are ineffective
on older releases that do not contain this implementation.

Leader mode is not a worker-only executable: it deliberately retains the
normal API and Socket.IO process for the current deployment architecture, but
`runtimeListenHost` binds it unconditionally to loopback. There is no flag or
override that can expose a leader listener. The routed `always` and `off`
modes preserve their existing managed-test/E2E listener behaviour.

The leadership lock uses one checked-out PostgreSQL session for the operational
database. Stop first signals every task to cancel future cycles, then joins all
active cycles before a normal leadership handoff. Concurrent stop calls join
the same drain. A failed normal drain must retain its live lock until the old
process is fenced; an operator must not start its replacement on a mere failed
stop acknowledgement. A lost database session cannot retain its server lock.

The twelve tasks cover authentication limits, MFA artefacts, expired editing
locks, invoice reminders, electronic invoices, supplier invoices, reporting,
webhook delivery, authoritative PDFs, planning forecasts, learned durations and
stock cost projection. Existing business transactions and delivery protections
remain in their respective services.

Readiness adds `runtime.background_workers` with the selected mode, leader
state and worker count. The route operator must verify both API slots in `off`
mode against their qualified runtime, not only an environment variable or a
caller-supplied success flag.

## Operational boundary

This change supplies the runtime prerequisite. It does not install containers,
change production configuration, choose a route, migrate a database, alter
credentials or enable a blue-green deployment automatically.

A separate release must qualify the actual source and artifacts. Bootstrap
must preserve the public Test/GED/update routes and the stable native API
address used for authorization policy. The dedicated worker is outside the
API/UI route pair. Replace it only after verified drain and process fencing.
The software fallback must retain a compatible Directory PIN-v2 runtime and
its key; reverting the Directory or database is not part of a traffic rollback.

Session locks and awaited callbacks do not provide exactly-once external
delivery or fencing during a network partition. Do not enable automatic worker
failover on that assumption. Those guarantees require an additional protocol
and separately verified business idempotency.

## Verification

The isolated tests exercise off-mode startup, exclusive leadership, active-cycle
drain for all twelve starters, concurrent shutdown, connection loss and failed
drain handling. A local PostgreSQL fixture verifies the actual advisory lock
and normal handoff. These are development proofs; canonical Candidate and
Production gates and a real provider/bootstrap rehearsal remain required.
