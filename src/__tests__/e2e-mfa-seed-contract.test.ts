import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("isolated MFA seed contract", () => {
  it("never creates an active SOL32ADMIN account without its primary role assignment", () => {
    const source = readFileSync(path.resolve("scripts/e2e/seed-mfa-sol32.js"), "utf8");

    expect(source).toContain("RETURNING id");
    expect(source).toContain("INSERT INTO public.user_role_assignments");
    expect(source).toContain("'Administrateur Systeme et Reseau'");
    expect(source).toContain("ON CONFLICT (user_id,role_key) DO NOTHING");
  });
});
