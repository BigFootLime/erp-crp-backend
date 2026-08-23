import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(__dirname, "..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(sourceRoot, relativePath), "utf8");
}

function exportedFunctionBody(contents: string, functionName: string): string {
  const functionStart = contents.indexOf(`export async function ${functionName}`);
  const constStart = contents.indexOf(`export const ${functionName} =`);
  const start = functionStart >= 0 ? functionStart : constStart;
  if (start < 0) throw new Error(`Missing ${functionName}`);
  const nextFunction = contents.indexOf("\nexport async function ", start + 1);
  const nextConst = contents.indexOf("\nexport const ", start + 1);
  const candidates = [nextFunction, nextConst].filter((index) => index >= 0);
  const next = candidates.length ? Math.min(...candidates) : contents.length;
  return contents.slice(start, next);
}

describe("machine image upload ownership contract", () => {
  const routes = source("module/production/routes/production.routes.ts");
  const controller = source("module/production/controllers/production.controller.ts");
  const repository = source("module/production/repository/production.repository.ts");

  const endpoints = [
    { method: "post", route: "/machines/onboarding", handler: "createMachineOnboarding", repository: "repoCreateMachineOnboarding" },
    { method: "post", route: "/machines", handler: "createMachine", repository: "repoCreateMachine" },
    { method: "patch", route: "/machines/:id/onboarding", handler: "updateMachineOnboarding", repository: "repoUpdateMachineOnboarding" },
    { method: "patch", route: "/machines/:id", handler: "updateMachine", repository: "repoUpdateMachine" },
  ] as const;

  for (const endpoint of endpoints) {
    it(`${endpoint.method.toUpperCase()} ${endpoint.route} stages first and transfers ownership transactionally`, () => {
      expect(routes).toContain(
        `router.${endpoint.method}("${endpoint.route}", requireMachineCapability(`
      );
      const routeLine = routes.split("\n").find((line) =>
        line.includes(`router.${endpoint.method}("${endpoint.route}"`)
      );
      expect(routeLine).toContain('machineImageUpload.single("image")');
      expect(routeLine).not.toContain('upload.single("image")');

      const controllerBody = exportedFunctionBody(controller, endpoint.handler);
      expect(controllerBody).toContain("image_file: imageFile");

      const repositoryBody = exportedFunctionBody(repository, endpoint.repository);
      expect(repositoryBody).toContain("withUploadTransaction({");
      expect(repositoryBody).toContain("promoteSecureUpload(");
      expect(repositoryBody).toContain("requireMachineImagePromotion(client, row.image_path, params.image_file)");
      expect(repositoryBody).toContain("reconcileMachineMutation(expected)");
    });
  }

  it("uses staging middleware rather than direct final-directory image storage", () => {
    expect(routes).toContain('const machineImageUpload = createSecureUpload("image", { maxFiles: 1 });');
    expect(routes).not.toContain('import { upload } from "../../../middlewares/upload"');
  });

  it("requires activation after the owner write, so an unready image rolls back rather than succeeding", () => {
    for (const repositoryName of ["repoCreateMachine", "repoCreateMachineOnboarding", "repoUpdateMachineOnboarding", "repoUpdateMachine"] as const) {
      const body = exportedFunctionBody(repository, repositoryName);
      const ownerWrite = body.indexOf("RETURNING");
      const promotion = body.indexOf("requireMachineImagePromotion(client, row.image_path, params.image_file)");
      expect(ownerWrite).toBeGreaterThanOrEqual(0);
      expect(promotion).toBeGreaterThan(ownerWrite);
      expect(body.indexOf("withUploadTransaction({")).toBeLessThan(promotion);
    }
  });
});
