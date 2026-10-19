import { describe, expect, it } from "vitest";

import { isRetiredAccountMetadata, retiredAccountPredicate } from "./account-retirement";

describe("legacy account retirement marker", () => {
  it("recognizes only the exact v1 marker", () => {
    expect(isRetiredAccountMetadata({ cerp_account_retirement: { schema_version: 1, retired_at: "2026-10-19T00:00:00.000Z", operation_id: "op" } })).toBe(true);
    expect(isRetiredAccountMetadata({ cerp_account_retirement: { schema_version: "1" } })).toBe(false);
    expect(isRetiredAccountMetadata({ cerp_account_retirement: { schema_version: 2 } })).toBe(false);
    expect(isRetiredAccountMetadata({ job_title: "Atelier" })).toBe(false);
  });

  it("uses a missing-column-safe predicate scoped to its alias", () => {
    expect(retiredAccountPredicate("u")).toContain("to_jsonb(u)");
    expect(retiredAccountPredicate("u")).toContain("schema_version");
    expect(retiredAccountPredicate("u")).toContain("IS DISTINCT FROM '1'::jsonb");
    expect(() => retiredAccountPredicate("u; DROP TABLE users")).toThrow("Invalid account retirement table alias");
    expect(() => retiredAccountPredicate("public.users")).toThrow("Invalid account retirement table alias");
    expect(() => retiredAccountPredicate("public.users; DROP TABLE users")).toThrow("Invalid account retirement table alias");
  });
});
