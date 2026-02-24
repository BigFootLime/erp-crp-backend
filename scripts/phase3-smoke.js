#!/usr/bin/env node
/*
  Phase 3 smoke runner (manual).

  Required:
    - Backend running (default http://localhost:5000)
    - Valid JWT token (Authorization: Bearer ...)

  Examples:
    node scripts/phase3-smoke.js --commande-id 123 --token "<jwt>"
    node scripts/phase3-smoke.js --commande-id 123 --token "<jwt>" --decision SHIP_AVAILABLE_NOW
    node scripts/phase3-smoke.js --commande-id 123 --token "<jwt>" --decision SHIP_AVAILABLE_NOW --lines '[{"commande_ligne_id":1,"qty_ship_now":2}]'

  Env equivalents:
    API_BASE_URL, COMMANDE_ID, JWT_TOKEN
*/

function parseArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.set(key, next);
      i++;
    } else {
      out.set(key, "true");
    }
  }
  return out;
}

function getArg(map, key, fallback) {
  return map.has(key) ? String(map.get(key)) : fallback;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = getArg(args, "base-url", process.env.API_BASE_URL || "http://localhost:5000").replace(/\/$/, "");
  const commandeId = getArg(args, "commande-id", process.env.COMMANDE_ID || "");
  const token = getArg(args, "token", process.env.JWT_TOKEN || "");
  const decisionRaw = getArg(args, "decision", "");
  const linesRaw = getArg(args, "lines", "");

  if (!commandeId || !/^\d+$/.test(commandeId)) {
    console.error("Missing/invalid --commande-id (expected integer)");
    process.exit(1);
  }
  if (!token) {
    console.error("Missing --token (JWT)");
    process.exit(1);
  }

  const decision = decisionRaw ? decisionRaw : null;
  let lines = [];
  if (linesRaw) {
    const parsed = JSON.parse(linesRaw);
    if (!Array.isArray(parsed)) throw new Error("--lines must be a JSON array");
    lines = parsed;
  }

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const analyzeUrl = `${baseUrl}/api/v1/commandes/${commandeId}/analyze-stock`;
  const analyzeRes = await fetch(analyzeUrl, { method: "POST", headers: authHeaders, body: "{}" });
  const analyzeBody = await readJson(analyzeRes);
  console.log("\n/analyze-stock", analyzeRes.status);
  console.log(JSON.stringify(analyzeBody, null, 2));

  const genUrl = `${baseUrl}/api/v1/commandes/${commandeId}/generate-affaires`;
  const genPayload = { decision, lines };
  const genRes = await fetch(genUrl, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(genPayload),
  });
  const genBody = await readJson(genRes);
  console.log("\n/generate-affaires", genRes.status);
  console.log(JSON.stringify(genBody, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
