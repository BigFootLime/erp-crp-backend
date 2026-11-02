import { afterEach, describe, expect, it } from "vitest";
import { supplierSandboxEnabled } from "./supplier-sandbox-security";

const saved = {
  node: process.env.NODE_ENV,
  enabled: process.env.SUPPLIER_PORTAL_SANDBOX,
  database: process.env.DATABASE_URL,
};
afterEach(() => {
  process.env.NODE_ENV = saved.node;
  process.env.SUPPLIER_PORTAL_SANDBOX = saved.enabled;
  process.env.DATABASE_URL = saved.database;
});
describe("supplier sandbox gate", () => {
  it("requires all explicit isolated-pilot conditions", () => {
    process.env.NODE_ENV = "test";
    process.env.SUPPLIER_PORTAL_SANDBOX = "1";
    process.env.DATABASE_URL = "postgres://localhost:5432/cerp_test";
    expect(supplierSandboxEnabled()).toBe(true);
  });
  it("rejects production-like database endpoints and names", () => {
    process.env.NODE_ENV = "test";
    process.env.SUPPLIER_PORTAL_SANDBOX = "1";
    process.env.DATABASE_URL = "postgres://db.internal:5432/cerp_test";
    expect(supplierSandboxEnabled()).toBe(false);
    process.env.DATABASE_URL = "postgres://localhost:5432/cerp_prod";
    expect(supplierSandboxEnabled()).toBe(false);
  });
});
