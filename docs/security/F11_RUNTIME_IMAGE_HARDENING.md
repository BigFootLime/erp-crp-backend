# F11 — Runtime image hardening

## Scope

The F11 release image is built from the digest-pinned Node 24.18.0 / Alpine
3.24 base declared in the repository `Dockerfile`. This note covers only the
final runtime stage; build tooling remains available in the builder stage.

## Runtime reductions

- `libcrypto3` and `libssl3` are explicitly installed at `3.5.9-r0`; `zlib`
  is explicitly installed at `1.3.2-r1`. These are the Alpine v3.24 security
  patches selected during the F11 review.
- The final stage removes global `npm`, `npx`, and Corepack binaries and their
  global package trees after `npm ci --omit=dev`. The application starts with
  `node dist/index.js`; no entrypoint, health check, or shipped operational
  script invokes a package manager at runtime.
- The image retains the application production dependency tree, ClamAV,
  `curl`, `tini`, and `su-exec`. This is not a dependency suppression rule and
  does not waive any scanner finding.

## Qualification boundary

Qualification must use a clean Linux install and scan the resulting final
image. The scanner input is an archive made with `docker save`; scan it offline
with a pinned scanner image, no Docker socket, and no application checkout
mounted. Record the vulnerability database timestamp, image/archive digest,
JSON findings, and any unresolved CVEs.
