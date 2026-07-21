# CERP — Hosting & Database Access

> How the CERP/CERP+ backend and database are hosted, how the two run modes connect, and how to access the database for modifications. Written 2026-07-06. Assumes this repo stays **private** (it references internal IPs; it contains **no secrets**).
>
> Deeper infra detail lives in the frontend/governance repo `crp-systems-web`: `docs/devops/cerp-wireguard-db-deployment.md`, `docs/devops/cerp-wireguard-over-tcp.md`, `docs/devops/hyperbox2-postgres-runbook.md`, `docs/devops/cerp-connectivity-incident-2026-07-06.md`.

## 1. TL;DR

- **Backend:** runs in **two** places at once (same codebase, two deployments).
  - **Local** — on the atelier server **HYPERBOX2**, systemd service `cerp-api` (`node /srv/cerp/apps/api/dist/index.js`, port `:8080`), served to the LAN by Apache on `:8081`. Used by **on-site** users.
  - **VPS** — a Coolify container on the Hostinger VPS (`82.25.112.61`), public at `https://erp-backend.croix-rousse-precision.fr` (container port `:5000`). Used by **off-site** users.
- **Database:** lives **only on the atelier (HYPERBOX2)** — PostgreSQL 17, database `cerp_prod` (plus `cerp_test` for validation). It is the **single source of truth**. There is **no** database on the VPS.
- **How each backend reaches the DB:**
  - Local backend → `127.0.0.1:5432` (same machine).
  - VPS backend → `10.90.0.2:5432` over the **WireGuard** tunnel (which now rides **TCP** — see the WG-over-TCP runbook — because the atelier's Bouygues 4G/5G uplink throttles raw UDP).

## 2. Topology

```
ON-SITE (atelier LAN)                         OFF-SITE (internet)
  browser                                       browser
    │ http://cerp.local:8081                       │ https://cerp.croix-rousse-precision.fr
    ▼                                               ▼
  Apache :8081 (HYPERBOX2)                        VPS Traefik (Coolify, TLS)
    │ prox/localhost                                │ Host(erp-backend.…)
    ▼                                               ▼
  cerp-api :8080 (HYPERBOX2)                      backend container :5000 (VPS)
    │ 127.0.0.1:5432                                │ DATABASE_URL → 10.90.0.2:5432
    ▼                                               ▼  (WireGuard, tunnelled over TCP)
  ┌──────────────────────────── PostgreSQL 17 on HYPERBOX2 ────────────────────────────┐
  │  db cerp_prod (source of truth) + cerp_test    listen_addresses = 127.0.0.1,10.90.0.2 │
  └───────────────────────────────────────────────────────────────────────────────────┘
```

Both backends run the **same release**. The frontend is likewise deployed twice (Apache-served build on the atelier; Coolify-served build on the VPS). The login screen lets the user pick the database (`Production cerp_prod` / `Base test cerp_test`).

## 3. Database facts

| Item | Value |
|---|---|
| Engine | PostgreSQL 17 (pgdg, Ubuntu) on HYPERBOX2 |
| Databases | `cerp_prod` (prod, ~190 tables), `cerp_test` (validation) |
| App role | `cerp_app` — least-privilege (no superuser/createrole/createdb/replication) |
| Admin role | `postgres` (superuser) — local socket / peer auth only |
| `listen_addresses` | `127.0.0.1` (local backend) + `10.90.0.2` (WireGuard, for the VPS) |
| `pg_hba` | `127.0.0.1`, `::1`, and WG peer `10.90.0.1/32` — all `scram-sha-256`; local socket `peer` |
| Firewall | atelier `ufw` allows `5432` only from the WG peer; **not** exposed to LAN/WAN |
| Backups | nightly `cerp-pg-backup.timer` → `/var/backups/cerp` (custom-format, restore-tested) |
| Connection string shape | `postgresql://cerp_app:<password>@<host>:5432/cerp_prod` |

## 4. Accessing the database for modifications

**Recommended for admin / schema changes / migrations — no password needed** (peer auth as the OS `postgres` user, on the atelier):

```bash
# on HYPERBOX2 (SSH in, or the RustDesk terminal):
sudo -u postgres psql -d cerp_prod        # prod   (careful!)
sudo -u postgres psql -d cerp_test        # test / validation
```

**As the application user `cerp_app`** (needs the password):

```bash
psql "postgresql://cerp_app:<password>@127.0.0.1:5432/cerp_prod"   # on the atelier
```

- **Where the `cerp_app` password is stored** (it is deliberately **not** in this repo): the backend `.env` on the atelier (`/srv/cerp/apps/api/.env`), the VPS backend's **Coolify** `DATABASE_URL` env var, and the operator's password manager / the `pgAdmin-CERP-identifiants` desktop note. Keep those in sync — a drift between them is what broke on-site login on 2026-07-06.
- **pgAdmin (GUI):** installed on the HYPERBOX2 desktop, connects via `127.0.0.1`.
- **From off-site:** you don't connect to the DB directly; you go through the VPS backend API, which holds the WireGuard path.

**Migrations / schema changes** follow the existing convention: idempotent SQL in [`db/patches/`](../db/patches), applied with `psql`. Always **back up first** (run `sudo /usr/local/sbin/cerp-pg-backup.sh` on the atelier) and prefer testing on `cerp_test`.

## 5. Security notes

- The DB is never exposed publicly; the VPS reaches it only via WireGuard, and PG binds to localhost + the WG IP only.
- Never commit the DB password (or any secret) to this repo. Rotate `cerp_app`'s password if it is ever exposed, and update the backend `.env` + Coolify `DATABASE_URL` together.
- The backend must never log `DATABASE_URL`/JWT/passwords.
</content>
