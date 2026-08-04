#!/usr/bin/env node

const path = require("node:path");
const dotenv = require("dotenv");
const { Client } = require("pg");

const ROOT_DIR = path.resolve(__dirname, "..");
const RETENTION_DAYS = 90;

dotenv.config({ path: path.join(ROOT_DIR, ".env") });

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const result = await client.query(
      "SELECT public.prune_dashboard_usage_daily($1::integer)::text AS deleted_rows",
      [RETENTION_DAYS]
    );
    await client.query("COMMIT");
    process.stdout.write(`dashboard usage retention complete: ${result.rows[0]?.deleted_rows ?? "0"} row(s) deleted\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`dashboard usage retention failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
