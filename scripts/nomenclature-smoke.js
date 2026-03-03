/*
  Smoke test for code nomenclature endpoint.

  Usage:
    BASE_URL=http://localhost:5000 TOKEN=... node scripts/nomenclature-smoke.js
*/

const BASE_URL = (process.env.BASE_URL || "http://localhost:5000").replace(/\/$/, "");
const TOKEN = (process.env.TOKEN || "").trim();

function fail(msg) {
  console.error(`[nomenclature-smoke] ${msg}`);
  process.exitCode = 1;
}

async function main() {
  const url = `${BASE_URL}/api/v1/codes/formats`;
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    fail(`GET ${url} -> ${res.status}\n${text}`);
    return;
  }

  const json = await res.json();
  const items = Array.isArray(json?.items) ? json.items : null;
  if (!items) {
    fail("Invalid response: expected { items: [...] }");
    return;
  }

  const byKey = new Map(items.map((it) => [String(it.key), it]));
  const mustHave = [
    "client",
    "devis",
    "commande",
    "affaire",
    "bonLivraison",
    "reception",
    "nonConformity",
    "capa",
  ];

  for (const k of mustHave) {
    if (!byKey.has(k)) fail(`Missing format key: ${k}`);
  }

  for (const it of items) {
    if (!it || typeof it !== "object") {
      fail("Invalid item (not an object)");
      continue;
    }
    const key = String(it.key || "");
    const regexSrc = String(it.regex || "");
    const example = String(it.example || "");

    if (!key) fail("Item missing 'key'");
    if (!regexSrc) fail(`Item '${key}' missing 'regex'`);
    if (!example) fail(`Item '${key}' missing 'example'`);

    try {
      const re = new RegExp(regexSrc);
      if (!re.test(example)) {
        fail(`Item '${key}': example '${example}' does not match regex /${regexSrc}/`);
      }
    } catch (e) {
      fail(`Item '${key}': invalid regex '${regexSrc}' (${String(e)})`);
    }
  }

  if (!process.exitCode) {
    console.log(`[nomenclature-smoke] OK (${items.length} formats) -> ${url}`);
  }
}

main().catch((e) => {
  fail(`Unhandled error: ${String(e?.stack || e)}`);
});
