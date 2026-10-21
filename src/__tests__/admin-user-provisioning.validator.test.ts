import { describe, expect, it } from "vitest";

import { adminCreateUserSchema, adminUpdateUserSchema } from "../module/admin/validators/admin.validators";
import { ASSIGNABLE_USER_ROLES } from "../module/auth/domain/roles";

const idempotencyKey = "7eb84d7e-9df1-4ee7-a8e9-3ee6c85b2bee";

describe("administrative user provisioning validator", () => {
  it("allows all catalogue functions during account creation and subsequent editing", () => {
    const functions = { role: "Responsable Qualité", roles: [...ASSIGNABLE_USER_ROLES] };
    expect(functions.roles.length).toBeGreaterThan(20);

    const created = adminCreateUserSchema.parse({
      headers: { idempotencyKey },
      body: { username: "QUALITE.TEST", name: "Compte", surname: "Qualité", email: "qualite@example.test", ...functions },
    });
    expect(created.body).toMatchObject({ ...functions, status: "Inactive" });

    const updated = adminUpdateUserSchema.parse({ params: { id: "42" }, body: functions });
    expect(updated.body).toEqual(functions);
  });

  it("accepts a minimal account and defaults it to Inactive", () => {
    const parsed = adminCreateUserSchema.parse({
      headers: { idempotencyKey },
      body: {
        username: " atelier.test ",
        name: "Compte",
        surname: "Atelier",
        email: "atelier.test@example.test",
        role: "Employee",
        roles: ["Employee"],
      },
    });

    expect(parsed.body).toMatchObject({
      username: "ATELIER.TEST",
      status: "Inactive",
      country: "France",
      role: "Employee",
    });
    expect(parsed.body).not.toHaveProperty("salary");
    expect(parsed.body).not.toHaveProperty("social_security_number");
  });

  it("rejects an unknown field instead of accepting a silent HR dossier extension", () => {
    expect(() =>
      adminCreateUserSchema.parse({
        headers: { idempotencyKey },
        body: {
          username: "ATELIER.TEST",
          name: "Compte",
          surname: "Atelier",
          email: "atelier.test@example.test",
          role: "Employee",
          hidden_hr_payload: "forbidden",
        },
      }),
    ).toThrow();
  });

  it("preserves supplemental roles supported by the current multi-role contract", () => {
    const parsed = adminCreateUserSchema.parse({
      headers: { idempotencyKey },
      body: {
        username: "ATELIER.TEST",
        name: "Compte",
        surname: "Atelier",
        email: "atelier.test@example.test",
        role: "Employee",
        roles: ["Employee", "Directeur"],
      },
    });

    expect(parsed.body.roles).toEqual(["Employee", "Directeur"]);
  });

  it("requires a UUID idempotency key", () => {
    expect(() =>
      adminCreateUserSchema.parse({
        headers: { idempotencyKey: "retry-me" },
        body: {
          username: "ATELIER.TEST",
          name: "Compte",
          surname: "Atelier",
          email: "atelier.test@example.test",
          role: "Employee",
        },
      }),
    ).toThrow();
  });

  it("rejects administrator-selected passwords and active provisioning", () => {
    for (const forbidden of [
      { password: "P@ssword12" },
      { status: "Active" },
    ]) {
      expect(() => adminCreateUserSchema.parse({
        headers: { idempotencyKey },
        body: {
          username: "ATELIER.TEST",
          name: "Compte",
          surname: "Atelier",
          email: "atelier.test@example.test",
          role: "Employee",
          roles: ["Employee"],
          ...forbidden,
        },
      })).toThrow();
    }
  });
});
