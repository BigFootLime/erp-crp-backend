# Blue/green runtime operator plan (#1381)

This is a preparation-only runbook. It does not authorize a production deploy,
proxy reload, database change, restart, or secret access.

## Observed topology (2026-10-19, read-only)

- VPS: Traefik (`coolify-proxy`) owns public `:80/:443`. The live backend
  router for `erp-backend.croix-rousse-precision.fr` targets container port
  `5000`; it has 4 GiB and 2 CPU reserved. The VPS has 43 GiB free disk,
  about 10 GiB available memory and four CPUs.
- Main web is a static Nginx container. Its same-origin API and Socket.IO paths
  are separately routed by Traefik file configuration to the current Docker
  backend service. They must move together in any flip.
- HYPER: Apache `:8081` forwards `/api/` and `/socket.io/` to local API
  `127.0.0.1:8080`; `cerp-api.service` is restart-always (five seconds),
  limited to 6 GiB/six CPUs. HYPER has no Docker runtime. WireGuard is active.

The public web front door and public backend host currently converge on the same
Docker backend service, while HYPER `:8081` is a separate LAN front door.
Consequently every web, Electron, APK and LAN client must first be qualified
against one stable HTTP *and* WebSocket front door. A VPS-only switch is refused
while any client still calls a Docker alias or HYPER `:8081` directly.

## Candidate contract

1. Stage API and worker with distinct names on a private Docker network.
   Candidate containers have `traefik.enable=false`, no `caddy_*` labels, no
   public alias, and no shared service name with the live application.
2. Publish only loopback fixture ports while qualifying. Docker health checks
   use `/health/live`; a worker's `/health/ready=503` means standby and must
   never trigger a restart loop.
3. API candidates run `CERP_RUNTIME_ROLE=api`; exactly one approved worker runs
   `worker`. Before the first worker is enabled, drain old jobs on both VPS and
   HYPER because release 139 does not take the leader lock. This has a planned
   short interruption window; it is not a zero-interruption migration.
4. Require candidate HTTP, Socket.IO handshake and worker live checks before a
   route change. Require the selected worker ready state after legacy drain.

## Approved-operator sequence (idempotent and compensating)

1. Record current route target, image reference, API/WS client endpoint matrix,
   and free capacity. Refuse if the matrix contains an unmanaged alias.
2. Create isolated candidate(s); verify that inspection contains no public
   router/service labels. A sick candidate or failed WS handshake stops here.
3. Drain legacy maintenance on VPS and HYPER, then start one new worker and
   wait for its private readiness. Do not start a second worker.
4. Atomically replace the stable front-door HTTP and WebSocket upstream together
   with the already-qualified API candidate. Verify the route points to exactly
   one service, then verify HTTP and WebSocket externally.
5. Drain old API/WebSocket connections under the approved timeout. Keep old
   artifacts and volumes intact until the rollback window closes.

If any gate fails before step 4, remove only the isolated candidate. If it fails
after step 4, atomically restore the captured previous HTTP+WS target and
restart the prior worker only after stopping the candidate worker. Rollback
never restores or rewrites the database.

RPO 1h and RTO 4h are recovery objectives, not hardware high availability.

## Local operator and fixture qualification

`scripts/blue-green-runtime-operator.mjs` is a library for an approved
operator, not a deployment CLI. It executes no shell command. Its concrete
`TraefikFileRouteAdapter` changes only the named API and Socket.IO router
service fields, and `ApacheRouteAdapter` changes only their `ProxyPass` and
`ProxyPassReverse` upstreams. Each write is compare-and-swap, fsynced,
renamed, and read back. A caller must provide HTTP-and-WebSocket front-door
verification for **both** hosts; promotion refuses an adapter without it.

The plan requires a digest-pinned API candidate, matching HTTP/WebSocket
routes, explicit VPS/HYPER endpoints, the 20 GiB VPS reserve and an explicit
legacy-worker drain. Candidate health is bounded to 30 seconds and requires
`role=api`, ready state, an API response, and a WebSocket upgrade.

VPS and HYPER remain two phases. If HYPER write or service verification fails,
the operator restores any HYPER change and the VPS route using the exact
post-write hashes, reads both files back, and reruns the old front-door service
verification. It raises `COMPENSATION_FAILED` if any restoration cannot be
proved. The library has no database rollback and has not been connected to
production credentials or route files.

Run local fixtures only:

```text
node --test scripts/tests/blue-green-runtime-fixture.test.mjs scripts/tests/blue-green-runtime-operator.test.mjs
```
