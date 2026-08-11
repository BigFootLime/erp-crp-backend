import fs from "node:fs";

import { describe, expect, it } from "vitest";
import { repoPath } from "./helpers/repo-paths";

const dockerfile = fs.readFileSync(repoPath("Dockerfile"), "utf8");
const entrypoint = fs.readFileSync(repoPath("docker/entrypoint.sh"), "utf8");
const storagePreflight = fs.readFileSync(repoPath("docker/storage-preflight.mjs"), "utf8");
const gitAttributes = fs.readFileSync(repoPath(".gitattributes"), "utf8");

describe("Dockerfile storage permissions", () => {
  it("copies every build-time security guard before npm run build", () => {
    const securityScriptsIndex = dockerfile.indexOf("COPY scripts/security ./scripts/security");
    const buildIndex = dockerfile.indexOf("RUN npm run build");

    expect(securityScriptsIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(securityScriptsIndex);
  });

  it("creates image defaults and revalidates runtime mounts before dropping privileges", () => {
    const mkdirIndex = dockerfile.indexOf("RUN mkdir -p");
    const dataIndex = dockerfile.indexOf("/app/data/documents");
    const chownIndex = dockerfile.indexOf("chown node:node");
    const parentModeIndex = dockerfile.indexOf("chmod 0750 /app/data");
    const chmodIndex = dockerfile.indexOf("chmod 0700");
    const entrypointIndex = dockerfile.indexOf('ENTRYPOINT ["/sbin/tini"');

    expect(mkdirIndex).toBeGreaterThanOrEqual(0);
    expect(dataIndex).toBeGreaterThan(mkdirIndex);
    expect(chownIndex).toBeGreaterThan(dataIndex);
    expect(parentModeIndex).toBeGreaterThan(chownIndex);
    expect(chmodIndex).toBeGreaterThan(parentModeIndex);
    expect(entrypointIndex).toBeGreaterThan(chmodIndex);
    expect(dockerfile).toContain("/app/data/tmp");
    expect(dockerfile).toContain("/app/uploads");
    expect(dockerfile).toContain("docker/storage-preflight.mjs");
    expect(dockerfile).not.toContain("chown -R node:node /app/data /app/uploads");
    expect(entrypoint.indexOf("cerp-storage-preflight.mjs"))
      .toBeLessThan(entrypoint.indexOf('su-exec node "$@" &'));
    expect(entrypoint).toContain("CERP_STORAGE_PREFLIGHT_ONLY");
    expect(entrypoint).toContain("CERP_STORAGE_SECURITY_SMOKE");
    expect(entrypoint).toContain('su-exec node "$@" &');
  });

  it("declares storage and ClamAV signatures as runtime volumes", () => {
    expect(dockerfile).toContain('VOLUME ["/app/data", "/app/uploads", "/var/lib/clamav"]');
  });

  it("embeds the deployed source commit in runtime health metadata", () => {
    expect(dockerfile).toContain("ARG SOURCE_COMMIT=unknown");
    expect(dockerfile).toContain("ENV CERP_RELEASE_VERSION=${SOURCE_COMMIT}");
  });

  it("normalizes shell entrypoints for images built from a Windows checkout", () => {
    expect(gitAttributes).toContain("*.sh text eol=lf");
    expect(gitAttributes).toContain("docker/*.conf text eol=lf");
    expect(dockerfile).toContain("sed -i 's/\\r$//' ");
    expect(dockerfile).toContain("/etc/clamav/freshclam.conf");
    expect(dockerfile.indexOf("sed -i 's/\\r$//' ")).toBeLessThan(
      dockerfile.indexOf("chmod 0755 /usr/local/bin/cerp-entrypoint.sh")
    );
  });

  it("inventories legacy mounts before a bounded descriptor-based migration", () => {
    expect(storagePreflight).toContain('const ALLOWED_MOUNT_ROOTS = ["/app/data", "/app/uploads"]');
    expect(storagePreflight).toContain("const initial = ALLOWED_MOUNT_ROOTS.map(inventoryRoot)");
    expect(storagePreflight).toContain("allowedOwners");
    expect(storagePreflight).toContain("hardlink escapes mounted storage inventory");
    expect(storagePreflight).toContain("O_NOFOLLOW");
    expect(storagePreflight).toContain("fchownSync");
    expect(storagePreflight).toContain("fchmodSync");
    expect(storagePreflight).toContain("DATA_PARENT_MODE = 0o750");
    expect(storagePreflight).toContain("PRIVATE_MODE = 0o700");
    expect(storagePreflight).toContain("FILE_MODE = 0o600");
    expect(storagePreflight).toContain("CERP_STORAGE_PREFLIGHT_MAX_NODES");
    expect(storagePreflight).toContain("opened.mtimeMs !== record.mtimeMs");
    expect(storagePreflight).toContain("secured.mtimeMs !== record.mtimeMs");
    expect(storagePreflight).toContain("const migratedFiles = new Set()");
    expect(storagePreflight).not.toMatch(/chown\s+-R|chmod\s+-R/);
  });
});
