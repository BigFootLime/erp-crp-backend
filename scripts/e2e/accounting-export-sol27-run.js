#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const POSTGRES_IMAGE = "postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229";
const port = Number(process.env.CERP_SOL27_DB_PORT || 55448);
const container = `cerp-sol27-${process.pid}-${Date.now()}`;
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "cerp-sol27-"));
const databaseUrl = `postgresql://cerp_e2e:cerp_sol27_only@127.0.0.1:${port}/cerp_test`;
let started = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: options.env || process.env,
    encoding: "utf8",
    windowsHide: true,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`SOL-27 isolated command failed (${result.status}): ${command} ${args.join(" ")}`);
  }
  return result;
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "cerp_e2e", "-d", "cerp_test"], { windowsHide: true, stdio: "ignore" });
    if (result.status === 0) {
      const settle = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(settle, 0, 0, 750);
      return;
    }
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, 250);
  }
  throw new Error("SOL-27 isolated PostgreSQL did not become ready");
}

try {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("CERP_SOL27_DB_PORT is invalid");
  run("docker", [
    "run", "--name", container, "--rm", "-d",
    "-e", "POSTGRES_USER=cerp_e2e", "-e", "POSTGRES_PASSWORD=cerp_sol27_only", "-e", "POSTGRES_DB=cerp_test",
    "-p", `127.0.0.1:${port}:5432`, "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g", POSTGRES_IMAGE,
  ], { capture: true });
  started = true;
  waitForPostgres();
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    CERP_E2E_ISOLATED: "1",
    CERP_E2E_QUIET: "1",
    CERP_GED_VAULT_ROOT: path.join(runtime, "ged-vault"),
    CERP_SOL27_INTEGRATION: "1",
  };
  fs.mkdirSync(env.CERP_GED_VAULT_ROOT, { recursive: true });
  run(process.execPath, ["scripts/e2e/migrate-isolated.js"], { env });
  run(process.execPath, ["scripts/e2e/seed-isolated.js"], { env });
  const vitest = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
  run(process.execPath, [vitest, "run", "src/module/accounting-export/accounting-export.integration.test.ts"], { env });
  process.stdout.write("SOL-27 isolated accounting export E2E passed; production access impossible.\n");
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
} finally {
  if (started) spawnSync("docker", ["rm", "-f", container], { windowsHide: true, stdio: "ignore" });
  const resolved = path.resolve(runtime);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("cerp-sol27-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
