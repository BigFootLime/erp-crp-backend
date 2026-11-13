# Backend blue/green preparation

This directory is a **staged** HYPERBOX2 procedure. It does not contact a
server, enable a service, change Apache, open a firewall port, or apply a
migration. A release owner must review and explicitly run it from the atelier
host.

## Architecture

`blue` and `green` are two loopback-only Node processes on the same HYPERBOX2
host. They use the same production PostgreSQL database, shared directory
authority, JWT/MFA configuration, GED mount and PostgreSQL-backed rate limiter.
No application data is copied between colours. Apache remains the LAN entry
point and the private GED relay upstream.

## Public route limitation

The current public API is a **Coolify container on the VPS**, directly selected
by Traefik at `erp-backend.croix-rousse-precision.fr`. It does not traverse the
HYPERBOX2 Apache `:8081` vhost. Only the public GED path currently traverses
the WireGuard relay. Consequently, these HYPERBOX2 artifacts do **not** make
the web API blue/green by themselves. A separate reviewed Coolify/Traefik
release pair is required for the public container before any claim of full
web-and-LAN blue/green recovery. The staged VPS pair is under `vps/`: it uses
two stable private Docker names on the existing `coolify` network and a Traefik
file-provider route with priority 100. That priority is derived from the live
route ordering: it beats the legacy generic route while remaining below the
existing GED (210) and test (220) routes. It adds no public listener.

| Slot | Loopback port | External firewall change |
| --- | ---: | --- |
| blue | 18080 | none |
| green | 18081 | none |

The existing `cerp-api` service remains the production service until the
operator has completed the readiness and compatibility checks. The existing
`cerp-api-test` service remains a test environment and is never a colour.

## Important current constraint

The legacy deployed backend starts several periodic workers at every process
start. Starting a second legacy process would duplicate maintenance work.
The candidate source now implements `CERP_STANDBY=true`,
`CERP_BACKGROUND_WORKERS=off` and a database advisory-lock leader lifecycle,
with unit and isolated PostgreSQL tests. This does not mean those guards are
already deployed. Both production entry points must use this lifecycle before
either template is promoted; an old `always` process is not protected by the
new advisory lock.

Socket.IO rooms and event delivery are process-local. Existing sockets keep
their old connection during an Apache graceful reload, but they do not receive
events emitted only by the new process until they reconnect. The release gate
therefore requires a controlled drain and an authenticated reconnect check;
shared JWT/MFA/session epochs and rate limits do not make Socket.IO broadcasts
globally shared. HTTP authorization, MFA/session epochs and rate limits are
database-backed and can be checked on the standby colour before traffic moves.

## Required release gates

1. Additive database migration only; its isolated rehearsal and backup must
   pass before both colours use the schema.
2. Same JWT secret, `AUTH_RATE_LIMIT_STORE=postgres`, directory endpoint and
   GED sentinel configuration on both colours. The preflight only checks their
   presence/value class; it never prints secrets.
3. Target `/health/ready` must be ready for the whole 30-second observation
   window, with database, GED, media, antivirus and realtime checks up.
4. Preserve the previous Apache upstream fragment and both immutable release
   directories. The switch helper atomically restores the prior fragment if
   Apache validation or the 30-second post-switch health check fails.
5. Check one authenticated HTTP request and one Socket.IO reconnect in the
   release window. Keep the former colour alive for the documented drain
   window before stopping it.
6. During a financial cutover in `PREPARING`, both the candidate and fallback
   must enforce the persistent financial emission guard. A pre-guard backend
   is not a compatible rollback target. Preserve the additive schema, evidence
   and current phase; a software rollback must not reopen financial issuance.

## First migration from the current VPS container

The current Coolify container uses the legacy default `always` worker mode.
It must never run concurrent recurring work with a promoted colour.

Coolify remains owner of that legacy application. Stopping its current
container alone is insufficient: a health failure or automatic deployment can
recreate it with `always` workers. Before the route is promoted, the release
owner must either disable legacy automatic deployment/restart for the migration
window, or deploy the lifecycle-capable image there with
`CERP_BACKGROUND_WORKERS=leader`. Record which choice was made.

HYPERBOX2 is another production API process against the same database. It too
must be changed from legacy `always` to `leader` (or held in `standby`) in the
same controlled window. The advisory lock only protects processes using this
new lifecycle; it cannot suppress periodic work from an older release.

1. Build and pin the reviewed image. Create `/etc/cerp/bluegreen/shared.env`
   from the current approved Coolify environment without printing it, then
   create `blue.env` as standby (`CERP_STANDBY=true`,
   `CERP_BACKGROUND_WORKERS=off`).
2. Start **blue only** using `vps/bin/stage-standby.sh blue` with the reviewed
   compose file, root-owned environment and the full attested backend commit.
   It leaves Traefik unchanged, requires the candidate to have no host port,
   checks its exact release metadata and stops it again on preflight failure.
   The disk/memory gate prevents a second full-size service from being started
   blindly on the VPS.
3. Install the Traefik file-provider active route with
   `vps/bin/switch-traefik.sh blue <active-file> <legacy-route-backup>`. It
   has priority 100: the old generic Coolify router is superseded, while the
   existing test and GED rules retain their higher priorities.
4. During the 30-second route observation the legacy container is still alive,
   so rollback simply restores the previous Traefik file. Verify an
   authenticated request and a Socket.IO reconnect.
5. After the drain, stop the legacy container. Change blue to
   `CERP_STANDBY=false` and `CERP_BACKGROUND_WORKERS=leader`, recreate only
   blue, and verify leader acquisition. This short maintenance-worker gap is
   intentional; it prevents duplicate periodic jobs. Reversal after that point
   first starts and checks the legacy container, then restores its route.

The initial installation of the two Apache `IncludeOptional` hooks is also a
one-time, reversible bootstrap: install the reviewed local-vhost candidate and
replace only the two existing GED proxy directives with the managed include,
while its initial active fragments still target the current `127.0.0.1:8080`.
`bin/bootstrap-hyper-apache-bluegreen.sh` performs this conversion with
backups, an Apache config test and a thirty-second health observation. Until
that bootstrap succeeds, the HYPER switch helper has no managed fragments to
switch and must not be used.

The VPS standby preflight now requires both `CERP_STANDBY=true` and
`CERP_BACKGROUND_WORKERS=off` in the effective container. The current live
configuration has neither flag, so it is not a candidate and must first be
replaced by the reviewed lifecycle-aware release on both the VPS and HYPER
before colours are added. This is a compatibility requirement, especially
while the financial cutover guard is `PREPARING` or `ACTIVE`: a pre-guard
release is not a valid fallback.

## Isolated route rehearsal before public promotion

Use the existing isolated test database/API route only. Create a temporary
private Traefik router for a non-public host or explicit internal test path,
with a priority below the production test routes and no public DNS record. Its
two targets must run `CERP_STANDBY=true`, with outgoing email/webhooks disabled
by the existing test environment settings. Exercise readiness, authenticated
HTTP, MFA and one Socket.IO reconnect; restore the prior private fragment and
record the result. This rehearsal does not send mail, run periodic workers,
import data or alter public production traffic.

## Operator sequence after approval

1. Place the reviewed release under `/srv/cerp/releases/<release-id>`.
2. Copy `systemd/cerp-api-bluegreen@.service` and a root-owned slot environment
   file. Start the **standby** slot only after its worker behaviour is safe.
3. Run `bin/preflight.sh <slot> <env-file>` locally on HYPERBOX2.
4. Run the browser/API and Socket.IO checks against the loopback target.
5. Use `bin/switch-apache-upstream.sh <slot> <prior-api-fragment>
   <managed-api-fragment> <prior-ged-fragment> <managed-ged-fragment>
   <apache-configtest-command>`. It replaces the normal API and the private GED
   relay fragments as one reviewed change, config-tests before a graceful reload,
   observes for at most 30 seconds, and restores both fragments on failure.
6. Record release id, colour, health result and the prior fragment checksum.
7. Drain and stop the former colour only after the socket reconnect check. Then
   set the promoted slot to `CERP_STANDBY=false` and
   `CERP_BACKGROUND_WORKERS=leader`; it acquires the PostgreSQL advisory lock
   only after the former leader releases it. The lifecycle stops recurring work
   before unlock, including on a lost leader connection. Individual workers
   still need their native stop functions to complete their own asynchronous
   work; this release does not claim a global job-quiescence proof.

This is an application rollback mechanism. It does not roll back business data:
for data imports, follow the separate recovery-set procedure.
