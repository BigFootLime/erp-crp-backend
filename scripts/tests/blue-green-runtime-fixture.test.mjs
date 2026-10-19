import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixture = await readFile(new URL("../../docker/blue-green-runtime.fixture.yml", import.meta.url), "utf8");

test("candidate fixture cannot register a public router or Docker DNS endpoint", () => {
  assert.match(fixture, /traefik\.enable: "false"/g);
  assert.doesNotMatch(fixture, /traefik\.http\.(routers|services)|caddy_/);
  assert.match(fixture, /127\.0\.0\.1:15000:5000/);
  assert.match(fixture, /127\.0\.0\.1:15001:5001/);
  assert.match(fixture, /internal: true/);
});

test("candidate liveness is separate from worker readiness", () => {
  assert.match(fixture, /health\/live/);
  assert.doesNotMatch(fixture, /health\/ready/);
  assert.match(fixture, /CERP_RUNTIME_ROLE: api/);
  assert.match(fixture, /CERP_RUNTIME_ROLE: worker/);
});
