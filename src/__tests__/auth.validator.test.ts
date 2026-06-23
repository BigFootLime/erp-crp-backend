import { describe, expect, it } from "vitest";

import { loginSchema } from "../module/auth/validators/auth.validator";

describe("auth login validator", () => {
  it("accepts the frontend database selector", () => {
    const parsed = loginSchema.parse({
      username: " admin ",
      password: "secret",
      database: "cerp_prod",
    });

    expect(parsed).toEqual({
      username: "ADMIN",
      password: "secret",
      database: "cerp_prod",
    });
  });

  it("keeps database optional for legacy callers", () => {
    const parsed = loginSchema.parse({
      username: "admin",
      password: "secret",
    });

    expect(parsed).toEqual({
      username: "ADMIN",
      password: "secret",
    });
  });

  it("rejects unknown database ids", () => {
    expect(() =>
      loginSchema.parse({
        username: "admin",
        password: "secret",
        database: "other",
      })
    ).toThrow();
  });
});
