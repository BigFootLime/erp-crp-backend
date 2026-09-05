// Read-only schema inspection, or fixture completion, for the disposable test DB.
const { Client } = require("pg");
const fs = require("node:fs");
async function main() {
  const url = new URL(process.env.DATABASE_URL || "http://invalid");
  if (
    process.env.CERP_E2E_ISOLATED !== "1" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55432" ||
    url.pathname !== "/cerp_test"
  )
    throw Error("Isolated production test database required");
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  try {
    if (process.argv.includes("--contract")) {
      await db.query("SET cerp.e2e_isolated='on'");
      await db.query(
        fs.readFileSync("db/e2e/historical-runtime-contract.sql", "utf8"),
      );
      console.log("Isolated historical contract applied");
    } else {
      const tables = process.argv.slice(2);
      const r = await db.query(
        `SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position`,
        [tables],
      );
      console.log(JSON.stringify(r.rows, null, 2));
    }
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
