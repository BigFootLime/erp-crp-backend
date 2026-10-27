import fs from "node:fs";
import express from "express";

const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const role = option("--role");
const mode = option("--mode");
const configPath = option("--config");
if ((role !== "buyer" && role !== "seller") || !mode || !["serve", "deliver", "reject"].includes(mode) || !configPath)
  throw new Error("usage: --role buyer|seller --mode serve|deliver|reject --config PRIVATE_FILE");
const fixture = new URL(process.env.DATABASE_URL ?? "");
if (fixture.hostname !== "127.0.0.1" || fixture.port !== "15464" || fixture.pathname !== `/cerp_ec1454_${role}_v2`)
  throw new Error("OWNED_V2_FIXTURE_ONLY");
const privateConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
const companies = { buyer: "11111111-1111-4111-8111-111111111111", seller: "22222222-2222-4222-8222-222222222222" };
const peerRole = role === "buyer" ? "seller" : "buyer";
const ports = { buyer: 18081, seller: 18082 };
process.env.NODE_ENV = "test";
process.env.CERP_BUSINESS_COMPANIES_ENABLED = "true";
process.env.CERP_SHARED_DIRECTORY_ENABLED = "true";
process.env.CERP_COMPANY_ID = companies[role];
process.env.CERP_COMPANY_ENVIRONMENT = "cerp_test";
process.env.CERP_INTERCOMPANY_ENABLED = "true";
process.env.CERP_INTERCOMPANY_PEERS_JSON = JSON.stringify([{
  company_id: companies[peerRole], environment: "cerp_test",
  api_base_url: `http://127.0.0.1:${ports[peerRole]}/api/v1`, signing_key_hex: privateConfig.signing_key_hex,
}]);

async function main() {
  // The application pool and fixed runtime are loaded after their process scope.
  const { default: pool } = await import("../../src/config/database");
  const { intercompanyDeliveryRoutes } = await import("../../src/module/entreprises/intercompany/intercompany.routes");
  const { runIntercompanyOutboxBatch } = await import("../../src/module/entreprises/intercompany/intercompany-worker");
  const { intercompanyTransportConfiguration, signIntercompanyDelivery } = await import("../../src/module/entreprises/intercompany/intercompany-transport");
  const actual = (await pool.query("SELECT current_database() AS database")).rows[0]?.database;
  if (actual !== `cerp_ec1454_${role}_v2`) throw new Error("FIXED_POOL_DATABASE_MISMATCH");
  if (mode === "serve") {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/v1/intercompany", intercompanyDeliveryRoutes);
    app.use((error: { status?: number; statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? error.statusCode ?? 500).json({ code: error.code ?? "HTTP_FIXTURE_ERROR" });
    });
    const server = app.listen(ports[role], "127.0.0.1", () => {
      process.stdout.write(`FIXED_PEER_READY ${JSON.stringify({ role, database: actual, port: ports[role] })}\n`);
    });
    const close = () => server.close(() => { void pool.end(); });
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    return;
  }
  try {
    if (mode === "deliver") {
      const totals = { delivered: 0, failed: 0 };
      for (let i = 0; i < 20; i++) {
        const batch = await runIntercompanyOutboxBatch(pool, intercompanyTransportConfiguration(), { limit: 10 });
        totals.delivered += batch.delivered;
        totals.failed += batch.failed;
        if (batch.delivered + batch.failed === 0) break;
      }
      const persisted = (await pool.query(`SELECT count(*)::int AS acknowledged FROM cerp_intercompany_outbox
        WHERE source_company_id=$1::uuid AND environment='cerp_test' AND delivered_at IS NOT NULL`, [companies[role]])).rows[0];
      process.stdout.write(`FIXED_HTTP_WORKER ${JSON.stringify({ role, database: actual, ...totals, ...persisted })}\n`);
      if (totals.failed || !persisted.acknowledged) throw new Error("FIXED_HTTP_WORKER_NOT_QUALIFIED");
    } else {
      const message = (await pool.query("SELECT message FROM cerp_intercompany_outbox ORDER BY created_at DESC LIMIT 1")).rows[0]?.message;
      if (!message) throw new Error("OUTBOX_MESSAGE_REQUIRED");
      const headers = signIntercompanyDelivery(message, privateConfig.signing_key_hex);
      const url = `http://127.0.0.1:${ports[peerRole]}/api/v1/intercompany/messages`;
      const valid = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
      if (valid.status !== 200) throw new Error(`VALID_REPLAY_HTTP_${valid.status}`);
      const receipt = await valid.json() as { status?: string };
      if (receipt.status !== "REPLAY") throw new Error("EXPECTED_PERSISTED_INBOX_REPLAY");
      for (const [header, value] of [["X-CERP-Intercompany-Signature", "0".repeat(64)], ["X-CERP-Intercompany-Destination", companies[role]], ["X-CERP-Intercompany-Environment", "cerp_prod"]]) {
        const response = await fetch(url, { method: "POST", headers: { ...headers, [header]: value }, body: JSON.stringify(message) });
        if (response.status !== 403) throw new Error(`EXPECTED_403_FOR_${header}`);
      }
      process.stdout.write(`FIXED_HTTP_REPLAY_AND_DENIALS ${JSON.stringify({ role, replay: receipt.status, signature: 403, destination: 403, environment: 403 })}\n`);
    }
  } finally { await pool.end(); }
}

void main().catch(error => {
  process.stderr.write(`FIXED_HTTP_FAILED ${error instanceof Error ? error.message : "FAILED"}\n`);
  process.exitCode = 1;
});
