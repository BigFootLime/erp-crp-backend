// A local-only runner for the production workbench browser rehearsal.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const runtime = path.resolve(__dirname, "../../../isolated-runtime-712");
const credentialsFile = path.join(runtime, "credentials.json");
fs.mkdirSync(runtime, { recursive: true });
let credentials;
if (fs.existsSync(credentialsFile))
  credentials = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
else {
  credentials = {
    password: crypto.randomBytes(24).toString("base64url"),
    jwt: crypto.randomBytes(48).toString("hex"),
  };
  fs.writeFileSync(credentialsFile, JSON.stringify(credentials), {
    mode: 0o600,
    flag: "wx",
  });
}
const env = {
  NODE_ENV: "test",
  CERP_E2E_ISOLATED: "1",
  CERP_E2E_MANAGED_STACK: "1",
  DATABASE_URL: "postgresql://cerp_712@127.0.0.1:55432/cerp_test",
  PORT: "50712",
  FRONTEND_URL: "http://127.0.0.1:51712",
  BACKEND_URL: "http://127.0.0.1:50712",
  CORS_ORIGINS: "http://127.0.0.1:51712",
  JWT_SECRET: credentials.jwt,
  CERP_E2E_RUN_ROOT: path.dirname(runtime),
  CERP_ROOT: runtime,
  CERP_STORAGE_ROOT: path.join(runtime, "storage"),
  CERP_DOCUMENTS_ROOT: path.join(runtime, "documents"),
  CERP_GENERATED_ROOT: path.join(runtime, "generated"),
  CERP_INBOUND_ROOT: path.join(runtime, "inbound"),
  CERP_EXPORTS_ROOT: path.join(runtime, "exports"),
  CERP_TMP_ROOT: path.join(runtime, "tmp"),
  CERP_IMAGES_ROOT: path.join(runtime, "images"),
  CERP_GED_VAULT_ROOT: path.resolve(runtime, "../isolated-ged"),
  RESEND_API_KEY: "",
  RESEND_FROM: "",
  RESEND_API_BASE_URL: "",
  E2E_PASSWORD: credentials.password,
  E2E_USERNAME: "KEENAN",
  E2E_BASE_URL: "http://127.0.0.1:51712",
  VITE_API_BASE_URL: "/api/v1",
  VITE_API_PROXY_TARGET: "http://127.0.0.1:50712",
  E2E_RUN_ROOT: runtime,
};
Object.assign(process.env, env);
for (const name of [
  "CERP_STORAGE_ROOT",
  "CERP_DOCUMENTS_ROOT",
  "CERP_GENERATED_ROOT",
  "CERP_INBOUND_ROOT",
  "CERP_EXPORTS_ROOT",
  "CERP_TMP_ROOT",
  "CERP_IMAGES_ROOT",
])
  fs.mkdirSync(env[name], { recursive: true });
async function main() {
  if (process.argv.includes("--prepare")) {
    const { Client } = require("pg");
    const bcrypt = require("bcryptjs");
    const c = new Client({ connectionString: env.DATABASE_URL });
    await c.connect();
    try {
      if (
        (await c.query("SELECT current_database() AS name")).rows[0].name !==
        "cerp_test"
      )
        throw Error("Isolated DB required");
      await c.query(
        `UPDATE public.users SET password=$1 WHERE username='KEENAN'`,
        [await bcrypt.hash(credentials.password, 10)],
      );
      console.log(
        "Isolated browser account prepared; credentials remain in the local runtime.",
      );
    } finally {
      await c.end();
    }
    return;
  }
  if (process.argv.includes("--server")) {
    require(
      require.resolve("ts-node/register/transpile-only", {
        paths: [path.dirname(require.resolve("ts-node-dev/package.json"))],
      }),
    );
    require("../../src/index.ts");
    return;
  }
  if (process.argv.includes("--playwright")) {
    require(
      require.resolve("ts-node/register/transpile-only", {
        paths: [path.dirname(require.resolve("ts-node-dev/package.json"))],
      }),
    );
    const { decryptMfaSecret } = require("../../src/module/auth/domain/mfa.ts");
    const { Client } = require("pg");
    const c = new Client({ connectionString: env.DATABASE_URL });
    await c.connect();
    try {
      const factor = (
        await c.query(
          "SELECT f.encrypted_secret,f.encryption_iv,f.encryption_tag,f.key_id FROM public.user_mfa_factors f JOIN public.users u ON u.id=f.user_id WHERE u.username='KEENAN' AND f.state='ACTIVE' ORDER BY f.enrolled_at DESC LIMIT 1",
        )
      ).rows[0];
      if (factor)
        process.env.E2E_MFA_SECRET = decryptMfaSecret({
          encrypted: factor.encrypted_secret,
          iv: factor.encryption_iv,
          tag: factor.encryption_tag,
          keyId: factor.key_id,
        });
    } finally {
      await c.end();
    }
    const {
      seedProductionWorkbenchFixture,
    } = require("../../src/__tests__/fixtures/production-workbench.fixture.ts");
    const {
      evaluateOfPreparation,
      repoSavePreparationDecisions,
    } = require("../../src/module/production/repository/production-preparation.repository.ts");
    const database = require("../../src/config/database.ts").default;
    const fixture = await seedProductionWorkbenchFixture();
    const e = await evaluateOfPreparation(database, fixture.ids[2]);
    await repoSavePreparationDecisions(
      fixture.ids[2],
      {
        expected_updated_at: e.of.updated_at,
        version_id: fixture.version,
        expected_version: e.profile_version,
        decisions: {
          material: {
            mode: "NOT_REQUIRED",
            reason: "Matière fournie dans cet essai",
          },
          treatment: {
            mode: "NOT_REQUIRED",
            reason: "Aucun traitement demandé",
          },
          subcontract: {
            mode: "NOT_REQUIRED",
            reason: "Fabrication entièrement interne",
          },
          programming: {
            mode: "NONE",
            reason: "Opérations manuelles de démonstration",
          },
        },
      },
      fixture.audit,
    );
    process.env.E2E_WORKBENCH_OF = String(fixture.ids[2]);
    process.env.E2E_WORKBENCH_NUMERO = fixture.code + "-8";
    await database.end();
  }
  const frontend = path.resolve(__dirname, "../../../frontend");
  const mode = process.argv.includes("--frontend")
    ? "vite"
    : "@playwright/test";
  const entry =
    mode === "vite"
      ? path.join(frontend, "node_modules/vite/bin/vite.js")
      : path.join(frontend, "node_modules/@playwright/test/cli.js");
  const args =
    mode === "vite"
      ? ["--host", "127.0.0.1", "--port", "51712", "--strictPort"]
      : [
          "test",
          "e2e/production-workbench-712.spec.ts",
          "--workers=1",
          "--retries=0",
        ];
  const child = require("node:child_process").spawn(
    process.execPath,
    [entry, ...args],
    { cwd: frontend, env: process.env, stdio: "inherit", windowsHide: true },
  );
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
