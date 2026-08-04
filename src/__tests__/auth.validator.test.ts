import { describe, expect, it } from "vitest";

import { loginSchema, resetPasswordSchema } from "../module/auth/validators/auth.validator";
import { strictEmail } from "../module/auth/validators/_helpers";

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

  it("rejects unknown login body fields", () => {
    expect(() =>
      loginSchema.parse({
        username: "admin",
        password: "secret",
        unsafe: true,
      })
    ).toThrow();
  });

  it.each([
    ["stra\u00dfe", "STRASSE"],
    ["u\u017fer", "USER"],
    ["adm\u0131n", "ADMIN"],
    ["o\ufb03ce", "OFFICE"],
  ])("uses the stored-account username canonical form for %s", (username, expected) => {
    expect(loginSchema.parse({ username, password: "secret" }).username).toBe(expected);
  });

  it("normalizes email with NFKC and lowercase", () => {
    expect(strictEmail.parse(" O\ufb03CE@Example.Test ")).toBe("office@example.test");
  });

  it("does not trim or case-fold an opaque reset token", () => {
    const token = " AbC-opaque-token ";
    expect(resetPasswordSchema.parse({ token, newPassword: "P@ssw0rd-OK" }).token).toBe(token);
  });
});
