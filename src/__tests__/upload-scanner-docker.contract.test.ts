import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

describe("autonomous ClamAV Docker contract", () => {
  let dockerfile: string;
  let entrypoint: string;
  let clamdConfig: string;
  let freshclamConfig: string;
  let scannerSmoke: string;
  let scannerSource: string;
  let exampleEnv: string;
  let documentation: string;

  beforeAll(async () => {
    const root = process.cwd();
    [dockerfile, entrypoint, clamdConfig, freshclamConfig, scannerSmoke, scannerSource, exampleEnv, documentation] =
      await Promise.all([
        fs.readFile(path.join(root, "Dockerfile"), "utf8"),
        fs.readFile(path.join(root, "docker", "entrypoint.sh"), "utf8"),
        fs.readFile(path.join(root, "docker", "clamd.conf"), "utf8"),
        fs.readFile(path.join(root, "docker", "freshclam.conf"), "utf8"),
        fs.readFile(path.join(root, "docker", "scanner-smoke.mjs"), "utf8"),
        fs.readFile(path.join(root, "src", "shared", "uploads", "upload-scanner.ts"), "utf8"),
        fs.readFile(path.join(root, ".env_exemple"), "utf8"),
        fs.readFile(path.join(root, "docs", "upload-hardening.md"), "utf8"),
      ]);
  });

  it("installs, seeds, supervises, and health-checks clamd inside the image", () => {
    expect(dockerfile.match(/FROM node:24\.18\.0-alpine3\.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd/g)).toHaveLength(2);
    expect(dockerfile).not.toContain("node:20-alpine");
    expect(dockerfile).toContain('"https://dl-cdn.alpinelinux.org/alpine/v3.24/main"');
    expect(dockerfile).toContain('"https://dl-cdn.alpinelinux.org/alpine/v3.24/community"');
    expect(dockerfile).not.toContain("alpine/edge");
    expect(dockerfile).toContain("clamav-daemon");
    expect(dockerfile).toContain("clamav-clamdscan");
    expect(dockerfile).toContain('"clamav=1.4.6-r0"');
    expect(dockerfile).toContain('"clamav-daemon=1.4.6-r0"');
    expect(dockerfile).toContain('"clamav-clamdscan=1.4.6-r0"');
    expect(dockerfile).toContain('"freshclam=1.4.6-r0"');
    expect(dockerfile).toContain('"curl=8.21.0-r0"');
    expect(dockerfile).toContain('"tini=0.19.0-r3"');
    expect(dockerfile).toContain('"su-exec=0.3-r0"');
    expect(dockerfile).not.toMatch(/RUN\s+freshclam/);
    expect(dockerfile).toContain("addgroup node clamav");
    expect(dockerfile).toContain('ENV CERP_UPLOAD_SCAN_MODE=enforce');
    expect(dockerfile).toContain("COPY scripts/build ./scripts/build");
    expect(dockerfile).toContain("/health/ready");
    expect(dockerfile).toContain('ENTRYPOINT ["/sbin/tini"');
    expect(dockerfile).toContain('"/var/lib/clamav"');

    expect(entrypoint).toContain("freshclam --config-file");
    expect(entrypoint).toContain("clamd --config-file");
    expect(entrypoint).toContain("--ping=60:1");
    expect(entrypoint).toContain('CERP_SCANNER_SMOKE:-0');
    expect(entrypoint).toContain("cerp-storage-preflight.mjs");
    expect(entrypoint).toContain("su-exec node node /usr/local/lib/cerp-scanner-smoke.mjs");
    expect(entrypoint).toContain('su-exec node "$@"');
    expect(entrypoint).toContain('process_stat=$(cat "/proc/$pid/stat"');
    expect(entrypoint).toContain('process_state=${process_stat%% *}');
    expect(entrypoint).toContain('while process_is_running "$app_pid"');
    expect(entrypoint).toContain("API remains fail-closed");
    expect(entrypoint).toContain("signature freshness is degraded");
    expect(entrypoint).not.toContain('for pid in "$app_pid" "$clamd_pid" "$freshclam_pid"');
    expect(entrypoint).not.toContain("wait -n");
    expect(entrypoint).toContain('kill -TERM "$pid"');
    expect(entrypoint).toContain('kill -KILL "$pid"');
    expect(entrypoint).toContain('if wait "$app_pid"; then status=0; else status=$?; fi');
  });

  it("uses a private local socket and bounded resources covering the GED ceiling", () => {
    expect(clamdConfig).toMatch(/LocalSocketGroup\s+clamav/);
    expect(clamdConfig).toMatch(/LocalSocketMode\s+660/);
    expect(clamdConfig).toMatch(/FailIfCvdOlderThan\s+7/);
    expect(clamdConfig).toMatch(/MaxThreads\s+2/);
    expect(clamdConfig).toMatch(/MaxFileSize\s+550M/);
    expect(clamdConfig).toMatch(/MaxScanSize\s+550M/);
    expect(clamdConfig).toMatch(/PCREMaxFileSize\s+550M/);
    expect(clamdConfig).toMatch(/HeuristicAlerts\s+yes/);
    expect(clamdConfig).toMatch(/AlertExceedsMax\s+yes/);
    expect(clamdConfig).toMatch(/MaxRecursion\s+16/);
    expect(clamdConfig).toMatch(/MaxFiles\s+10000/);
    expect(freshclamConfig).not.toMatch(/^Checks\s+/m);
    expect(entrypoint).toContain("--checks=12");
    expect(freshclamConfig).toMatch(/NotifyClamd\s+\/etc\/clamav\/clamd\.conf/);
    expect(scannerSmoke).toContain("nestedArchive(20)");
    expect(scannerSmoke).toContain('exceeded.status !== "infected"');
  });

  it("keeps scan execution non-shell, cancellable, and free of temporary buffer files", () => {
    expect(scannerSource).toContain('shell: false');
    expect(scannerSource).toContain('["--fdpass", "--no-summary", "--", input.path]');
    expect(scannerSource).toContain('["--stream", "--no-summary", "-"]');
    expect(scannerSource).toContain('addEventListener("abort"');
    expect(scannerSource).toContain('child.kill("SIGTERM")');
    expect(scannerSource).toContain('child.kill("SIGKILL")');
    expect(scannerSource).toContain('process.env.CERP_E2E_CONTAINER !== "1"');
    expect(scannerSource).not.toContain('upload-scanner"), `${randomUUID()}.scan`');
  });

  it("documents Docker and Ubuntu/systemd fail-closed deployment contracts", () => {
    expect(exampleEnv).toContain("CERP_UPLOAD_SCAN_MODE=enforce");
    expect(exampleEnv).toContain("CERP_UPLOAD_SCANNER_TIMEOUT_MS=120000");
    expect(documentation).toContain("Node LTS `24.18.0` sur Alpine `3.24`");
    expect(documentation).toContain("`v3.24/community`");
    expect(documentation).toContain("aucun paquet `edge`");
    expect(documentation).toContain("n'embarque aucune base mutable");
    expect(documentation).toContain("premier démarrage d'un volume vide exige un accès sortant");
    expect(documentation).toContain("2 048 entrées");
    expect(documentation).toContain("CRC-32 de chaque");
    expect(documentation).toContain("2 Gio de RAM");
    expect(documentation).toContain("12 vérifications par jour");
    expect(documentation).toContain("base vieille de plus de 7 jours");
    expect(documentation).toMatch(/conserver\s+`enforce` pendant un\s+rollback/);
    expect(documentation).toContain("Ubuntu 24.04 Noble");
    expect(documentation).toContain("1.5.3+dfsg-0ubuntu0.24.04.1");
    expect(documentation).toContain("clamav-freshclam.service");
    expect(documentation).toContain("clamav-daemon.service");
    expect(documentation).toContain("User=cerp");
    expect(documentation).toContain("Group=cerp_write");
    expect(documentation).toContain("UMask=0007");
    expect(documentation).toContain("SupplementaryGroups=clamav");
    expect(documentation).not.toMatch(/`Group=cerp`(?!_write)/);
    expect(documentation).toContain("/srv/cerp/apps/api/.env.test");
    expect(documentation).toContain("`0640`");
    expect(documentation).toContain("cerp:cerp_write");
    expect(documentation).toContain("node:node");
    expect(documentation).toContain("`2770→3770`");
    expect(documentation).toContain("`0660→0600`");
    expect(documentation).toContain("CERP_UPLOAD_ADMIN_TRUST_ROOTS=/mnt/data");
    expect(documentation).toContain("17 150 fichiers `postgres:postgres`");
    expect(documentation).toContain("CERP_STORAGE_SECURITY_SMOKE=1");
    expect(documentation).toContain("racine et 14 répertoires `0755`");
    expect(documentation).toContain("racine et descendants `2755`");
    expect(documentation).toContain("environ 30 fichiers `0755`, `nlink=1`");
    expect(documentation).toContain("la découverte complète ne mute rien");
    expect(documentation).toContain("bind **peuplé** `/app/uploads`");
    expect(documentation).toContain("O_DIRECTORY|O_NOFOLLOW");
    expect(documentation).toContain("lien symbolique ou junction");
    expect(documentation).toContain(".secure-delete");
    expect(documentation).toContain("503 UPLOAD_CLEANUP_FAILED");
    expect(documentation).toContain("find -delete");
    expect(documentation).toContain("Il n'existe aucun succès silencieux");
    expect(documentation).toContain("LocalSocketMode 660");
    expect(documentation).toContain("CERP_UPLOAD_SCANNER_COMMAND=/usr/bin/clamdscan");
    expect(documentation).toContain("cerp_test");
    expect(documentation).toContain("cerp_prod");
    expect(documentation).toContain("503 UPLOAD_SCAN_UNAVAILABLE");
    expect(documentation).toContain("rollback systemd");
  });
});
