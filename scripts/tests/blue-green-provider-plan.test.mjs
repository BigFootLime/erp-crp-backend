import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertGedRelayDependency, buildPrivateCandidateFile, buildProviderAwarePlan, CANDIDATE_PRIORITY, validatePrivateCandidateLabels } from "../blue-green-provider-plan.mjs";

const fixture = await readFile(new URL("./fixtures/blue-green-runtime/vps-provider-exceptions.sanitized.yaml", import.meta.url), "utf8");
const exceptions = [...fixture.matchAll(/^    ([^:]+):\n      rule: (.+)\n      priority: (\d+)$/gm)].map(([, name, rule, priority]) => ({ name, rule, priority: Number(priority) }));
const hyperVhosts = JSON.parse(await readFile(new URL("./fixtures/blue-green-runtime/hyper-ged-wireguard.sanitized.json", import.meta.url), "utf8"));

test("candidate file routes both direct entrypoints and same-origin API/socket below live exceptions", () => {
  const file = buildPrivateCandidateFile({ service: "cerp-api-candidate", url: "http://cerp-api-candidate:3000", exceptions });
  assert.match(file, /entryPoints:\n        - http/); assert.match(file, /entryPoints:\n        - https/);
  assert.match(file, /Host\(`erp-backend\.croix-rousse-precision\.fr`\) && PathPrefix\(`\/`\)/);
  assert.match(file, /Host\(`cerp\.croix-rousse-precision\.fr`\) && PathPrefix\(`\/api\/`\)/);
  assert.match(file, /Host\(`cerp\.croix-rousse-precision\.fr`\) && PathPrefix\(`\/socket\.io\/`\)/);
  assert.match(file, new RegExp(`priority: ${CANDIDATE_PRIORITY}`));
  assert.equal(exceptions.every((item) => item.priority > CANDIDATE_PRIORITY), true);
});

test("provider plan retains old API until the exact WireGuard GED relay moves", () => {
  const plan = buildProviderAwarePlan({ service: "cerp-api-candidate", url: "http://cerp-api-candidate:3000", exceptions, hyperVhosts });
  assert.equal(assertGedRelayDependency(hyperVhosts).vhost, "/etc/apache2/sites-available/cerp-ged-wireguard.conf");
  assert.equal(plan.oldApiDrain.required, true);
  assert.match(plan.oldApiDrain.reason, /GED relay/);
});

test("candidate requires disabled Traefik and no public router labels", () => {
  validatePrivateCandidateLabels({ "traefik.enable": "false" });
  assert.throws(() => validatePrivateCandidateLabels({ "traefik.enable": "true" }), /explicitly disable/);
  assert.throws(() => validatePrivateCandidateLabels({ "traefik.enable": "false", "traefik.http.routers.public.rule": "Host(`x`)" }), /must not declare/);
});
