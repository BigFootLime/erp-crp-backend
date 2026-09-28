import { describe, expect, it, vi } from "vitest";

// The script is deliberately CommonJS so it can run in the release image
// without loading the Express application. Requiring it must not connect to DB.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const seed = require("../../scripts/seed-showcase-data.js") as {
  assertDemoEnvironment: (environment: NodeJS.ProcessEnv) => void;
  demoUsername: (environment: NodeJS.ProcessEnv) => string;
  runStage: <T>(name: string, operation: () => Promise<T>) => Promise<T>;
  ensureMachineAndPostes: (client: { query: ReturnType<typeof vi.fn> }, userId: number) => Promise<void>;
};

describe("showcase offline seed guards", () => {
  it("accepts only a dedicated cerp_demo URL and normalizes the configured account", () => {
    seed.assertDemoEnvironment({
      CERP_DEMO_MODE: "true",
      DATABASE_URL: "postgresql://demo:fixture@database/cerp_demo",
    });
    expect(seed.demoUsername({ DEMO_SEED_USERNAME: " showcase " })).toBe("SHOWCASE");
    expect(() => seed.assertDemoEnvironment({
      CERP_DEMO_MODE: "true",
      DATABASE_URL: "postgresql://demo:fixture@database/cerp_prod",
    })).toThrow(/cerp_demo/);
  });

  it("creates the two visual workshop resources with parameterized values", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: /RETURNING id/.test(sql) ? [{ id: "fixture-id" }] : [] }));
    await seed.ensureMachineAndPostes({ query }, 42);

    expect(query).toHaveBeenCalledTimes(4);
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.filter((sql) => sql.includes("INSERT INTO public.machines"))).toHaveLength(2);
    expect(statements.filter((sql) => sql.includes("INSERT INTO public.postes"))).toHaveLength(2);
    expect(query.mock.calls.flatMap(([, params]) => params ?? [])).toContain(42);
  });

  it("identifies a failed database operation by its seed stage without exposing parameters", async () => {
    await expect(seed.runStage("technical-piece-1", async () => {
      throw new Error("fixture constraint");
    })).rejects.toThrow("stage technical-piece-1 failed: fixture constraint");
  });
});
