// Disposable PostgreSQL only. Uses no environment URL, credentials or production data.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
const container = `cerp-nuance-library-test-${process.pid}`;
const docker = (args, input) => execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
// The initdb temporary server accepts Unix sockets before its final restart.
// Wait for loopback TCP inside the isolated container to avoid that false readiness.
const psqlArgs = ["exec", "-i", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
const sql = query => docker(psqlArgs, query).trim();
const patch = readFileSync(new URL("../../db/patches/20261113_stock_nuance_library.sql", import.meta.url), "utf8");
let checks = 0;
function check(actual, expected) { assert.equal(actual, expected); checks++; }
function rejected(query, message) {
  assert.throws(() => sql(query), error => String(error.stderr).includes(message));
  // psql exits immediately on errors; open transactions are rolled back on disconnect.
  checks++;
}
function concurrent(query) {
  const child = spawn("docker", psqlArgs, { stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stderr.on("data", value => { output += value; });
  child.stdin.end(query);
  return new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve({ code, output })); });
}
try {
  docker(["run", "--rm", "-d", "--name", container, "--network", "none", "--label", "cerp.scope=nuance-library-test", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.10"]);
  for (let attempt = 0; ; attempt++) {
    try { sql("SELECT 1"); break; } catch (error) { if (attempt >= 40) throw error; await delay(250); }
  }
  sql(`CREATE TABLE public.stock_nuances (id bigserial PRIMARY KEY, code text NOT NULL UNIQUE, designation text NOT NULL DEFAULT '', densite numeric, is_active boolean NOT NULL DEFAULT true, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE public.articles_matiere (article_id integer PRIMARY KEY, nuance_id bigint REFERENCES public.stock_nuances(id));
    INSERT INTO stock_nuances(code,densite) VALUES ('OLD-CODE',7.85),('LEGACY-316L',8.0);
    INSERT INTO articles_matiere VALUES (100,1);
  `);
  const support = suffix => readFileSync(new URL(`../../db/patches/support/20261113_stock_nuance_library.${suffix}.sql`, import.meta.url), "utf8");
  check(sql(support("preflight")), "2|0\n1");
  sql(patch); sql(patch);
  const verification = sql(support("verify"));
  assert(verification.includes("stock_nuances_library_werkstoff_uniq")); checks++;
  check(sql(support("rollback")), "2");
  check(sql("SELECT code || ':' || designation_principale || ':' || densite FROM stock_nuances WHERE id=1"), "OLD-CODE:LEGACY:7.85");
  check(sql("SELECT nuance_id FROM articles_matiere WHERE article_id=100"), "1");
  rejected("INSERT INTO stock_nuances(code) VALUES ('EMPTY')", "At least one standard");
  rejected("INSERT INTO stock_nuances(code,norme_en,designation_principale) VALUES ('INVALID','EN-DEMO','USA')", "stock_nuance_library_identity_check");
  rejected("INSERT INTO stock_nuances(code,norme_usa,designation_principale) VALUES ('LEGACY-ALIAS','legacy 316l','USA')", "historical nuance");
  sql("UPDATE stock_nuances SET norme_fr='FR-DEMO', norme_en='EN-DEMO', norme_werkstoff='1.4404', norme_usa='USA-DEMO', designation_principale='WERKSTOFF' WHERE id=1");
  check(sql("SELECT code || ':' || designation_principale FROM stock_nuances WHERE id=1"), "OLD-CODE:WERKSTOFF");
  sql("UPDATE stock_nuances SET designation_principale='USA',is_active=false WHERE id=1");
  for (const [field, value, primary] of [["norme_fr", "fr demo", "FR"], ["norme_en", "en-demo", "EN"], ["norme_werkstoff", "1 4404", "WERKSTOFF"], ["norme_usa", "usa.demo", "USA"]]) {
    rejected(`INSERT INTO stock_nuances(code,${field},designation_principale) VALUES ('DUP-${primary}','${value}','${primary}')`, `stock_nuances_library_${primary.toLowerCase()}_uniq`);
  }
  rejected("UPDATE stock_nuances SET norme_usa=null WHERE id=1", "stock_nuance_library_identity_check");
  rejected("UPDATE stock_nuances SET norme_fr=null,norme_en=null,norme_werkstoff=null,norme_usa=null,designation_principale='LEGACY' WHERE id=1", "must retain a standard");
  rejected("UPDATE stock_nuances SET code='RENAMED' WHERE id=1", "immutable");
  rejected("INSERT INTO stock_nuances(code,norme_usa,designation_principale) VALUES ('BAD','---','USA')", "Invalid standard");
  // Different standards remain distinct namespaces, rather than guessed equivalences.
  sql("INSERT INTO stock_nuances(code,norme_fr,designation_principale) VALUES ('NAMESPACE','USA-DEMO','FR')");
  check(sql("SELECT count(*) FROM stock_nuances WHERE norme_fr='USA-DEMO'"), "1");
  const first = concurrent("BEGIN; INSERT INTO stock_nuances(code,norme_usa,designation_principale) VALUES ('CONCURRENT-A','CONCURRENT','USA'); SELECT pg_sleep(1); COMMIT;");
  await delay(150);
  const second = concurrent("INSERT INTO stock_nuances(code,norme_usa,designation_principale) VALUES ('CONCURRENT-B','con current','USA');");
  const results = await Promise.all([first, second]);
  check(results.filter(result => result.code === 0).length, 1);
  check(sql("SELECT count(*) FROM stock_nuances WHERE public.stock_nuance_key(norme_usa)='CONCURRENT'"), "1");
  check(sql("SELECT nuance_id FROM articles_matiere WHERE article_id=100"), "1");
  // A pre-existing ambiguous catalog must abort, never silently merge/delete IDs.
  sql("DROP TRIGGER stock_nuance_library_guard ON stock_nuances; DROP INDEX stock_nuances_library_code_uniq; INSERT INTO stock_nuances(code,norme_en,designation_principale) VALUES ('OLD CODE','COLLISION','EN')");
  rejected(patch, "historical codes need review");
  check(sql("SELECT count(*) FROM stock_nuances WHERE public.stock_nuance_key(code)='OLDCODE'"), "2");
  console.log(`PASS: ${checks} PostgreSQL checks, migration replay, historical links, inactive/normalized duplicates and concurrent writes.`);
} finally {
  try { docker(["stop", container]); } catch { /* Container may not have started. */ }
}
