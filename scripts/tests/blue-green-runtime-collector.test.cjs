const assert = require("node:assert/strict");
const test = require("node:test");
const { redactUpstreamUrl, traefikRouterLabels } = require("../blue-green-runtime-collector.cjs");

test("extracts real flat Traefik router labels without regex escaping assumptions", () => {
  const labels = {
    "traefik.http.routers.cerp-api.rule": "Host(`erp-backend.croix-rousse-precision.fr`) && PathPrefix(`/api/`)",
    "traefik.http.routers.cerp-api.priority": "100",
    "traefik.http.routers.cerp-api.service": "cerp-api",
    "traefik.http.routers.cerp.api.socket.rule": "Host(`erp-backend.croix-rousse-precision.fr`) && PathPrefix(`/socket.io/`)",
    "traefik.http.routers.cerp.api.socket.service": "cerp-api",
    "traefik.http.services.cerp-api.loadbalancer.server.port": "3000",
  };
  assert.deepEqual(traefikRouterLabels(labels), {
    "cerp-api": { rule: labels["traefik.http.routers.cerp-api.rule"], priority: "100", service: "cerp-api" },
    "cerp.api.socket": { rule: labels["traefik.http.routers.cerp.api.socket.rule"], service: "cerp-api" },
  });
});

test("service URLs omit credentials and query strings", () => {
  assert.equal(redactUpstreamUrl("http://user:secret@10.0.0.4:8080/api?token=secret#fragment"), "http://10.0.0.4:8080/api");
});
