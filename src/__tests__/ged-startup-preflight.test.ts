import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { preflightVaultStorage } from "../module/ged/services/ged-vault.service";
import {
  preflightCriticalStorageAtStartup,
  requiresGedVaultStartupPreflight,
} from "../shared/runtime/critical-storage-preflight";

const originalEnvironment = { ...process.env };
const temporaryRoots: string[] = [];

afterEach(async () => {
  process.env = { ...originalEnvironment };
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("GED production startup preflight (#618)", () => {
  it("runs before generic root creation, route import and the HTTP listener", async () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(testDirectory, "..", "index.ts"), "utf8");
    const critical = source.indexOf("await preflightCriticalStorageAtStartup()")
    const genericRoots = source.indexOf("preflightSecureUploadStorageRoots()")
    const routeImport = source.indexOf('import("./config/app")')
    const listen = source.indexOf("httpServer.listen(")

    expect(critical).toBeGreaterThan(-1)
    expect(critical).toBeLessThan(genericRoots)
    expect(genericRoots).toBeLessThan(routeImport)
    expect(routeImport).toBeLessThan(listen)
  });

  it("cannot be disabled in production and aborts startup before success is reported", async () => {
    const probe = vi.fn().mockRejectedValue(Object.assign(new Error("synthetic GED outage"), { code: "EROFS" }));
    const environment = { NODE_ENV: "production", CERP_GED_STARTUP_PREFLIGHT: "false" } as NodeJS.ProcessEnv;

    expect(requiresGedVaultStartupPreflight(environment)).toBe(true);
    await expect(preflightCriticalStorageAtStartup(environment, { preflightGedVault: probe }))
      .rejects.toThrow("synthetic GED outage");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary tests optional but supports an exact opt-in rehearsal", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    await expect(preflightCriticalStorageAtStartup({ NODE_ENV: "test" } as NodeJS.ProcessEnv, { preflightGedVault: probe }))
      .resolves.toEqual({ ged_vault_required: false, ged_vault_ready: false });
    expect(probe).not.toHaveBeenCalled();

    await expect(preflightCriticalStorageAtStartup({ NODE_ENV: "test", CERP_GED_STARTUP_PREFLIGHT: "true" } as NodeJS.ProcessEnv, { preflightGedVault: probe }))
      .resolves.toEqual({ ged_vault_required: true, ged_vault_ready: true });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("proves sentinel readability plus real vault write, read and cleanup", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-ged-startup-"));
    temporaryRoots.push(parent);
    const vaultRoot = path.join(parent, "ged");
    const sentinel = path.join(vaultRoot, ".cerp-ged-volume");
    await fs.mkdir(vaultRoot, { recursive: true });
    await fs.writeFile(sentinel, "cerp-ged-volume-v1\n");
    process.env.NODE_ENV = "production";
    process.env.CERP_GED_VAULT_ROOT = vaultRoot;
    process.env.CERP_GED_SENTINEL = sentinel;
    process.env.CERP_GED_REQUIRE_SENTINEL = "false";

    await expect(preflightVaultStorage()).resolves.toBeUndefined();
    expect(await fs.readdir(path.join(vaultRoot, "staging"))).toEqual([]);
  });

  it("rejects a directory masquerading as the production volume sentinel", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-ged-startup-"));
    temporaryRoots.push(parent);
    const vaultRoot = path.join(parent, "ged");
    const fakeSentinel = path.join(vaultRoot, "fake-sentinel");
    await fs.mkdir(vaultRoot, { recursive: true });
    await fs.mkdir(fakeSentinel);
    process.env.NODE_ENV = "production";
    process.env.CERP_GED_VAULT_ROOT = vaultRoot;
    process.env.CERP_GED_SENTINEL = fakeSentinel;

    await expect(preflightVaultStorage()).rejects.toMatchObject({
      status: 503,
      code: "GED_VAULT_UNAVAILABLE",
    });
  });

  it("never creates a missing configured vault root as a local fallback", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-ged-startup-"));
    temporaryRoots.push(parent);
    const missingVaultRoot = path.join(parent, "missing-mount");
    process.env.NODE_ENV = "production";
    process.env.CERP_GED_VAULT_ROOT = missingVaultRoot;
    process.env.CERP_GED_SENTINEL = path.join(missingVaultRoot, ".cerp-ged-volume");

    await expect(preflightVaultStorage()).rejects.toMatchObject({
      status: 503,
      code: "GED_VAULT_UNAVAILABLE",
    });
    await expect(fs.stat(missingVaultRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a readable sentinel outside the configured vault volume", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-ged-startup-"));
    temporaryRoots.push(parent);
    const vaultRoot = path.join(parent, "ged");
    const outsideSentinel = path.join(parent, ".cerp-ged-volume");
    await fs.mkdir(vaultRoot, { recursive: true });
    await fs.writeFile(outsideSentinel, "wrong-volume\n");
    process.env.NODE_ENV = "production";
    process.env.CERP_GED_VAULT_ROOT = vaultRoot;
    process.env.CERP_GED_SENTINEL = outsideSentinel;

    await expect(preflightVaultStorage()).rejects.toMatchObject({
      status: 503,
      code: "GED_VAULT_UNAVAILABLE",
    });
  });
});
