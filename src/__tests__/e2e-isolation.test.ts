import { describe, expect, it } from "vitest";
import { assertE2EIsolation } from "../config/e2e-isolation";

function isolatedEnv(): NodeJS.ProcessEnv {
  const root = "C:/tmp/cerp-sol05";
  return {
    CERP_E2E_ISOLATED: "1",
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://e2e:test@127.0.0.1:55432/cerp_test",
    FRONTEND_URL: "http://127.0.0.1:55173",
    BACKEND_URL: "http://127.0.0.1:55000",
    CORS_ORIGINS: "http://127.0.0.1:55173",
    CERP_E2E_RUN_ROOT: root,
    CERP_ROOT: `${root}/root`,
    CERP_STORAGE_ROOT: `${root}/storage`,
    CERP_DOCUMENTS_ROOT: `${root}/documents`,
    CERP_GENERATED_ROOT: `${root}/generated`,
    CERP_INBOUND_ROOT: `${root}/inbound`,
    CERP_EXPORTS_ROOT: `${root}/exports`,
    CERP_TMP_ROOT: `${root}/tmp`,
    CERP_IMAGES_ROOT: `${root}/images`,
    CERP_GED_VAULT_ROOT: `${root}/ged`,
  };
}

describe("SOL-05 E2E isolation guard", () => {
  it("accepts a fully loopback disposable runtime", () => {
    expect(() => assertE2EIsolation(isolatedEnv())).not.toThrow();
  });

  it.each([
    ["DATABASE_URL", "postgresql://cerp:secret@db.production.example/cerp_prod"],
    ["FRONTEND_URL", "https://erp.example.com"],
    ["BACKEND_URL", "https://api.example.com"],
  ])("rejects a non-loopback %s", (name, value) => {
    const env = isolatedEnv();
    env[name] = value;
    expect(() => assertE2EIsolation(env)).toThrow(/loopback/);
  });

  it("rejects a production database name even on localhost", () => {
    const env = isolatedEnv();
    env.DATABASE_URL = "postgresql://e2e:test@127.0.0.1:55432/cerp_prod";
    expect(() => assertE2EIsolation(env)).toThrow(/cerp_test/);
  });

  it("rejects inherited outbound mail credentials and escaping storage", () => {
    const withMail = isolatedEnv();
    withMail.RESEND_API_KEY = "forbidden";
    expect(() => assertE2EIsolation(withMail)).toThrow(/email credentials/);

    const withEscape = isolatedEnv();
    withEscape.CERP_DOCUMENTS_ROOT = "C:/production/documents";
    expect(() => assertE2EIsolation(withEscape)).toThrow(/escapes/);
  });

  it("only accepts a managed loopback email sink", () => {
    const withSink = isolatedEnv();
    withSink.CERP_E2E_EMAIL_SINK = "1";
    withSink.RESEND_API_KEY = "disposable";
    withSink.RESEND_FROM = "CERP SOL-05 <no-reply@example.local>";
    withSink.RESEND_API_BASE_URL = "http://127.0.0.1:55001";
    expect(() => assertE2EIsolation(withSink)).not.toThrow();

    withSink.RESEND_API_BASE_URL = "https://api.resend.com";
    expect(() => assertE2EIsolation(withSink)).toThrow(/loopback/);
  });
});
