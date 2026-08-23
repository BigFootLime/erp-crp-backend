import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("#617 OF release migration safety contract", () => {
  const patch = read("db/patches/20260823_of_readiness_release_617.sql");
  const preflight = read("db/patches/support/20260823_of_readiness_release_617.preflight.sql");
  const verify = read("db/patches/support/20260823_of_readiness_release_617.verify.sql");
  const rollback = read("db/patches/support/20260823_of_readiness_release_617.rollback.sql");

  it("keeps one append-only release decision per OF", () => {
    expect(patch).toContain("of_release_decisions_one_per_of_uk UNIQUE (of_id)");
    expect(patch).toContain("BEFORE UPDATE OR DELETE ON public.of_release_decisions");
    expect(patch).toContain("ERRCODE = '55000'");
    expect(patch).toContain("GRANT SELECT, INSERT ON TABLE public.of_release_decisions TO cerp_app");
    expect(patch).toContain("REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.of_release_decisions FROM cerp_app");
  });

  it("preflights duplicates, verifies the live trigger, and keeps rollback test-only", () => {
    expect(preflight).toContain("GROUP BY of_id HAVING count(*) > 1");
    expect(verify).toContain("trg_of_release_decisions_append_only_617");
    expect(verify).toContain("UPDATE public.of_release_decisions SET evidence = evidence");
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("DROP FUNCTION IF EXISTS public.fn_of_release_decisions_append_only_617()");
  });
});
