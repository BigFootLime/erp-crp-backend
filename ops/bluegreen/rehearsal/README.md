# Isolated blue/green rehearsal

This exercise validates the *new immutable backend image* against a restored copy before any public route or production service is changed. It is deliberately separate from Coolify's live application and from the live Traefik file-provider directory.

## Preconditions

1. The release owner provides an immutable backend image digest which includes the background-lifecycle implementation. Do not use the legacy `860f…` image.
2. The restore operator reports `RESTORED_READY`: a disposable full-schema site database named `cerp_test_<32 lowercase hex>`, a separate disposable directory database named `cerp_directory_<same suffix>`, clone-only database roles, and a separate restored GED vault/sentinel. No production database, vault, directory authority, or customer upload may be mounted.
3. Create `/etc/cerp/rehearsal/rehearsal.env` with mode `0600`, owned by root. It must contain only clone-local secrets and endpoints. Do not copy it into a ticket, shell history, Git, or logs.
4. The private directory is an isolated sidecar in the API network namespace. It listens only at `127.0.0.1:8085`; the site API uses the exact approved endpoint `http://127.0.0.1:8085/internal/directory`. Do not substitute a Docker DNS name or the WireGuard/live authority.

`NODE_ENV=production` remains required so deployment checks run normally. The rehearsal is made safe through the clone-only connections and explicit outbound/workers disablement below.

## Files and controls

- `docker-compose.rehearsal.yml.template` creates an API, an isolated directory sidecar sharing the API network namespace, and an *ephemeral private Traefik* container on Docker's `coolify` network. Neither publishes a host port and none touches the live provider directory.
- `traefik/dynamic.yml` validates a route internally only. The test proxy has no host port; it can be reached only using `docker exec` from the VPS.
- `bin/preflight-isolated.sh` asserts the generated `cerp_test_<suffix>` site database, the matching separate directory database, loopback-only directory endpoint, private roots and pinned images without printing their values.
- `bin/run-rehearsal.sh` checks readiness through the private proxy, confirms anonymous rejection, and waits 30 seconds for stability. It does not log in or create business records.
- `bin/rollback-rehearsal.sh` removes only rehearsal containers and leaves the clone intact for investigation. The restore operator decides separately when disposable clone resources may be removed.

## Required environment contract

Start from `rehearsal.env.example`. The actual file must set:

- `CERP_REHEARSAL_IMAGE` to a digest, never a mutable tag.
- `DATABASE_URL` for the clone-only site role/database. It must be exactly `cerp_test_<32 lowercase hex>` and `CERP_REHEARSAL_DB_MARKER` is that hex suffix. `CERP_REHEARSAL_DIRECTORY_DATABASE_URL` must instead target the matching, separate `cerp_directory_<same suffix>` authority clone.
- `CERP_GED_VAULT_ROOT` and `CERP_GED_SENTINEL` inside the restored rehearsal vault. `CERP_REHEARSAL_VAULT_MARKER` must occur in both paths.
- the fixed clone-local `CERP_DIRECTORY_ENDPOINT=http://127.0.0.1:8085/internal/directory`, plus private caller-key file and directory storage roots. The caller-key file is `root:1000`, mode `0640`: it remains root-owned while the image's unprivileged `node` process can read it. The endpoint allowlist is not widened.
- `JWT_SECRET`, MFA and rate-limit values compatible with the clone only.

The following are compulsory: `CERP_STANDBY=true`, `CERP_BACKGROUND_WORKERS=off`, `CERP_WEBHOOK_DELIVERY_ENABLED=0`, `EINVOICE_EREPORTING_ENABLED=false`, and blank `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_API_BASE_URL`. Do not add mail/webhook credentials.

## Execution (only after release-owner authorization)

Run as root on the VPS from a private directory:

```bash
install -d -m 0700 /opt/cerp-rehearsal-1710
cp docker-compose.rehearsal.yml.template /opt/cerp-rehearsal-1710/compose.yml
cp -r traefik /opt/cerp-rehearsal-1710/
# Set the immutable digests and clone-local values in /etc/cerp/rehearsal/rehearsal.env.
./bin/preflight-isolated.sh /opt/cerp-rehearsal-1710/compose.yml
docker compose --env-file /etc/cerp/rehearsal/rehearsal.env -f /opt/cerp-rehearsal-1710/compose.yml up -d
./bin/run-rehearsal.sh /opt/cerp-rehearsal-1710/compose.yml
```

The result validates image startup, deployment checks, clone connectivity, GED sentinel access, private proxy routing, anonymous authentication rejection, and 30-second readiness stability. A controlled clone-local test account may then validate login/MFA and socket reconnection manually; it must never use a production identity.

On any failure or at the end:

```bash
./bin/rollback-rehearsal.sh /opt/cerp-rehearsal-1710/compose.yml
```

This is a rehearsal rollback only. It does not change live traffic, restart Coolify, touch the live dynamic route, or drop a database. A successful rehearsal does not activate blue/green; promotion still requires the separate live readiness and legacy-worker migration review.
