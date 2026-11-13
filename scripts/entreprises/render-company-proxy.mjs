#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMPANY_SITE = /^cerp_company_[0-9a-f]{32}_(prod|test)$/;
const TEST_SITE = /^cerp_test_[0-9a-f]{32}$/;
const ORIGIN = /^http:\/\/(127\.0\.0\.1|10\.90\.0\.2):(\d{4,5})$/;
const own = (value, keys) =>
  Object.keys(value).every((key) => keys.includes(key));

function fail(message) {
  throw new Error(`BUSINESS_COMPANY_PROXY_INVALID: ${message}`);
}

function validateOrigin(target) {
  if (
    !target ||
    typeof target !== "object" ||
    !own(target, ["profile", "origin"])
  ) {
    fail("target must contain only profile and origin");
  }
  if (
    !["local", "wireguard"].includes(target.profile) ||
    typeof target.origin !== "string"
  ) {
    fail("target profile/origin is invalid");
  }
  const match = ORIGIN.exec(target.origin);
  if (!match) fail("target origin must be an allow-listed http host and port");
  const port = Number(match[2]);
  if (port < 1024 || port > 65535) fail("target port must be 1024..65535");
  if ((target.profile === "local") !== (match[1] === "127.0.0.1")) {
    fail("target profile does not match its allow-listed origin");
  }
  return { profile: target.profile, origin: target.origin };
}

function validateDatabase(database, environment) {
  if (typeof database !== "string") fail("database is required");
  const valid =
    (environment === "prod" &&
      (database === "cerp_prod" ||
        (COMPANY_SITE.test(database) && database.endsWith("_prod")))) ||
    (environment === "test" &&
      (database === "cerp_test" ||
        TEST_SITE.test(database) ||
        (COMPANY_SITE.test(database) && database.endsWith("_test"))));
  if (!valid) fail("database does not match the canonical environment");
  return database;
}

export function validateCompanyProxyManifest(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    !own(raw, ["companies"]) ||
    !Array.isArray(raw.companies)
  ) {
    fail("manifest must contain only companies");
  }
  const routes = raw.companies.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !own(entry, [
        "company_id",
        "environment",
        "database",
        "profile",
        "target",
        "commercial_api_worker",
      ])
    ) {
      fail(`companies[${index}] contains an unsupported field`);
    }
    if (typeof entry.company_id !== "string" || !UUID.test(entry.company_id)) {
      fail(`companies[${index}].company_id must be a lowercase canonical UUID`);
    }
    if (!["prod", "test"].includes(entry.environment))
      fail(`companies[${index}].environment is invalid`);
    if (!["COMMERCIAL", "INDUSTRIAL"].includes(entry.profile))
      fail(`companies[${index}].profile is invalid`);
    if (typeof entry.commercial_api_worker !== "boolean")
      fail(`companies[${index}].commercial_api_worker must be boolean`);
    const target = validateOrigin(entry.target);
    if (
      entry.profile === "COMMERCIAL" &&
      (entry.commercial_api_worker || target.profile !== "local")
    ) {
      fail(
        "commercial companies require their API worker off external targets",
      );
    }
    return Object.freeze({
      companyId: entry.company_id,
      environment: entry.environment,
      database: validateDatabase(entry.database, entry.environment),
      profile: entry.profile,
      target,
    });
  });
  if (routes.length === 0) fail("manifest has no company route");
  const unique = (value, label) => {
    if (new Set(value).size !== value.length) fail(`${label} must be unique`);
  };
  unique(
    routes.map((route) => `${route.companyId}:${route.environment}`),
    "company/environment route",
  );
  unique(
    routes.map((route) => route.database),
    "database route",
  );
  unique(
    routes.map((route) => route.target.origin),
    "target origin",
  );
  return Object.freeze(routes);
}

function restRule(route) {
  const database = canonicalDatabase(route.environment);
  return [
    `RewriteCond %{HTTP:X-CERP-Company} ^${route.companyId}$`,
    `RewriteCond %{HTTP:X-CERP-Database} ^${database}$`,
    `RewriteRule ^/api/v1/(.*)$ ${route.target.origin}/api/v1/$1 [P,L,NE]`,
  ].join("\n");
}

function socketRule(route, websocket) {
  const scheme = websocket ? "ws" : "http";
  const upgrade = websocket ? "^websocket$" : "!^websocket$";
  const database = canonicalDatabase(route.environment);
  return [
    `RewriteCond %{QUERY_STRING} (^|&)company=${route.companyId}(&|$)`,
    `RewriteCond %{QUERY_STRING} (^|&)database=${database}(&|$)`,
    `RewriteCond %{HTTP:Upgrade} ${upgrade} [NC]`,
    `RewriteRule ^/socket.io/(.*)$ ${route.target.origin.replace(/^http/, scheme)}/socket.io/$1 [P,L,NE]`,
  ].join("\n");
}

function canonicalDatabase(environment) {
  return environment === "prod" ? "cerp_prod" : "cerp_test";
}

export function renderCompanyProxyInclude(raw) {
  const routes = validateCompanyProxyManifest(raw);
  const knownCompanyConditions = routes
    .map((route) => `RewriteCond %{HTTP:X-CERP-Company} !^${route.companyId}$`)
    .join("\n");
  return [
    "# Generated by scripts/entreprises/render-company-proxy.mjs. Do not edit by hand.",
    "# Include this fragment before legacy /api and /socket.io catch-all proxy rules.",
    "# Legacy requests without company stay with the existing rules; non-empty company is fail-closed.",
    "RewriteEngine On",
    "",
    routes.map(restRule).join("\n\n"),
    "",
    routes
      .flatMap((route) => [socketRule(route, true), socketRule(route, false)])
      .join("\n\n"),
    "",
    "# A provided but unknown/malformed company never reaches a legacy CRP fallback.",
    "RewriteCond %{HTTP:X-CERP-Company} !^$",
    knownCompanyConditions,
    "RewriteRule ^/(api/v1|socket\.io)(/.*)?$ - [R=403,L]",
    "# A known company with a wrong database, or a Socket.IO company query without a registered pair, also fails closed.",
    "RewriteCond %{HTTP:X-CERP-Company} !^$",
    "RewriteRule ^/api/v1(/.*)?$ - [R=403,L]",
    "RewriteCond %{QUERY_STRING} (^|&)company=[^&]+(&|$)",
    "RewriteRule ^/socket\.io(/.*)?$ - [R=403,L]",
    "",
    "# Authentication/JWT/company authorization remains enforced by the selected backend runtime.",
    "# The VPS nginx/Traefik layer must pass X-CERP-Company, X-CERP-Database and Socket.IO query strings unchanged to this Apache boundary.",
    "",
  ].join("\n");
}

function parseCli(args) {
  const options = { input: null, output: null };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if ((option === "--input" || option === "--output") && args[index + 1]) {
      options[option.slice(2)] = args[(index += 1)];
    } else fail("usage: --input manifest.json [--output workspace/file.conf]");
  }
  if (!options.input) fail("--input is required");
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const rendered = renderCompanyProxyInclude(
    JSON.parse(await readFile(options.input, "utf8")),
  );
  if (!options.output) return process.stdout.write(rendered);
  const workspace = path.resolve(process.cwd());
  const destination = path.resolve(options.output);
  if (!destination.startsWith(`${workspace}${path.sep}`))
    fail("--output must stay inside the current workspace");
  await writeFile(destination, rendered, "utf8");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
