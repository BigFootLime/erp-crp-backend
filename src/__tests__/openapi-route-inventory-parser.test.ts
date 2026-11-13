import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const generator = path.resolve(process.cwd(), "scripts/openapi/generate-route-inventory.mjs");
const fixtures: string[] = [];

function fixture(entryBody: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cerp-openapi-route-inventory-"));
  fixtures.push(root);
  fs.mkdirSync(path.join(root, "src/routes"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/routes/v1.routes.ts"), entryBody, "utf8");
  fs.writeFileSync(
    path.join(root, "src/routes/specialized.routes.ts"),
    'import { Router } from "express";\nconst router = Router();\nrouter.get("/specialized", (_req, res) => res.json({ specialized: true }));\nexport default router;\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "src/routes/legacy.routes.ts"),
    'import { Router } from "express";\nconst router = Router();\nrouter.get("/legacy", (_req, res) => res.json({ legacy: true }));\nexport default router;\n',
    "utf8",
  );
  return root;
}

function mountCall(parent: string, mounts: string): string {
  return [
    'import { Router } from "express";',
    'import specializedRoutes from "./specialized.routes";',
    'import legacyRoutes from "./legacy.routes";',
    'import { mountOrderedRouteGroup } from "./route-mount-order";',
    "const router = Router();",
    `mountOrderedRouteGroup(${parent}, ${mounts});`,
    "export default router;",
  ].join("\n");
}

function grouped(mounts: string): string {
  return mountCall("router", [
    "[",
    mounts,
    "]",
  ].join("\n"));
}

function run(root: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, [generator, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

afterEach(() => {
  const temporaryParent = fs.realpathSync(os.tmpdir());
  while (fixtures.length > 0) {
    const candidate = fixtures.pop()!;
    const resolved = fs.realpathSync(candidate);
    if (
      path.relative(temporaryParent, path.dirname(resolved)) !== "" ||
      !path.basename(resolved).startsWith("cerp-openapi-route-inventory-")
    ) {
      throw new Error(`refusing to remove fixture outside its temporary root: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("OpenAPI ordered-route parser", () => {
  it("keeps the complete checked-in route contract", () => {
    const output = execFileSync(process.execPath, [generator, "--check"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(output).toContain("1755 operations");
  });

  it("accepts literal ordered mounts", () => {
    const root = fixture(grouped([
      '{ prefix: "/shared", router: specializedRoutes },',
      '{ prefix: "/shared", router: legacyRoutes },',
    ].join("\n")));

    const result = run(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("4 operations");
  });

  it.each([
    ["non-literal mount array", mountCall("router", "mounts"), "mountOrderedRouteGroup requires a literal mount array"],
    ["unresolved parent alias", mountCall("missingRouter", "[]"), "mountOrderedRouteGroup requires a declared Router identifier"],
    ["parent expression", mountCall("Router()", "[]"), "mountOrderedRouteGroup requires a declared Router identifier"],
    ["array spread", grouped("...mounts,"), "has a non-literal ordered mount"],
    ["dynamic prefix", grouped('{ prefix: routePrefix, router: specializedRoutes },'), "ordered mount requires literal prefix and router identifier"],
    ["getter", grouped('{ get prefix() { return "/shared"; }, router: specializedRoutes },'), "has an unsupported ordered mount property"],
    ["computed prefix", grouped('{ ["prefix"]: "/shared", router: specializedRoutes },'), "has an unsupported ordered mount property"],
    ["unresolved router", grouped('{ prefix: "/shared", router: missingRouter },'), "has an unresolved ordered mounted router"],
  ])("rejects %s instead of silently dropping routes", (_name, entry, error) => {
    const root = fixture(entry);
    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
  });
});
