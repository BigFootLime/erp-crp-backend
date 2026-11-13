import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const runner = require("../../scripts/db-patches.js");
const filename = "20261113_stock_nuance_library.sql";
describe("Nuance-only guarded migration", () => {
  it("selects exactly the checksum-pinned Nuance patch, with the canonical inventory intact", () => {
    const options = runner.parseArgs(["up", "--dry-run", "--only", filename]);
    expect(options.only).toBe(filename);
    const patches = runner.listPatches(resolve("db/patches"));
    const selected = runner.immutableOnlyPatch(patches, filename);
    expect(selected.filename).toBe(filename);
    expect(selected.sha256).toBe(runner.sha256Sql(readFileSync(resolve("db/patches", filename), "utf8")));
    expect(() => runner.immutableOnlyPatch([{ ...selected, sha256: "0".repeat(64) }], filename)).toThrow(/checksum mismatch/);
    expect(() => runner.parseArgs(["up", "--only", "unregistered.sql"])).toThrow(/not registered/);
  });
});
