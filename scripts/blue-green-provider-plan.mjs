import assert from "node:assert/strict";

export const CANDIDATE_PRIORITY = 200;

function scalar(value) {
  assert.match(value, /^[a-z0-9][a-z0-9@._-]*$/i, "candidate service name is invalid");
  return value;
}

export function validatePrivateCandidateLabels(labels) {
  assert.equal(labels?.["traefik.enable"], "false", "candidate must explicitly disable Traefik");
  assert.equal(Object.keys(labels).some((key) => key.startsWith("traefik.http.routers.")), false, "candidate must not declare public Traefik routers");
}

export function assertExceptionPrecedence(exceptions) {
  for (const exception of exceptions) {
    assert.ok(Number.isInteger(exception.priority) && exception.priority > CANDIDATE_PRIORITY, `exception ${exception.name} must outrank the candidate`);
    assert.match(exception.rule, /Host\(`/, `exception ${exception.name} must have an explicit host rule`);
  }
}

export function buildPrivateCandidateFile({ service, url, exceptions }) {
  scalar(service); const upstream = new URL(url);
  assert.ok(["http:", "https:"].includes(upstream.protocol), "candidate service URL must be HTTP(S)");
  assert.equal(upstream.username + upstream.password + upstream.search + upstream.hash, "", "candidate service URL must not contain credentials, query, or fragment");
  assertExceptionPrecedence(exceptions);
  const apiHost = "erp-backend.croix-rousse-precision.fr", webHost = "cerp.croix-rousse-precision.fr";
  return `http:
  routers:
    cerp-candidate-direct-http:
      entryPoints:
        - http
      rule: Host(\`${apiHost}\`) && PathPrefix(\`/\`)
      priority: ${CANDIDATE_PRIORITY}
      service: ${service}
    cerp-candidate-direct-https:
      entryPoints:
        - https
      rule: Host(\`${apiHost}\`) && PathPrefix(\`/\`)
      priority: ${CANDIDATE_PRIORITY}
      service: ${service}
    cerp-candidate-web-api:
      rule: Host(\`${webHost}\`) && PathPrefix(\`/api/\`)
      priority: ${CANDIDATE_PRIORITY}
      service: ${service}
    cerp-candidate-web-socket:
      rule: Host(\`${webHost}\`) && PathPrefix(\`/socket.io/\`)
      priority: ${CANDIDATE_PRIORITY}
      service: ${service}
  services:
    ${service}:
      loadBalancer:
        servers:
          - url: ${upstream.toString()}
`;
}

export function assertGedRelayDependency(vhosts) {
  const matches = vhosts.flatMap((vhost) => (vhost.directives ?? []).filter((directive) => directive.directive === "ProxyPass" && directive.path === "/api/v1/ged/" && directive.upstream === "http://127.0.0.1:8080/api/v1/ged/").map((directive) => ({ vhost: vhost.resolved_path, ...directive })));
  assert.equal(matches.length, 1, "exactly one HYPER GED relay to the old API is required");
  return matches[0];
}

export function buildProviderAwarePlan({ service, url, exceptions, hyperVhosts }) {
  const gedRelay = assertGedRelayDependency(hyperVhosts);
  return {
    candidateFile: buildPrivateCandidateFile({ service, url, exceptions }),
    candidatePriority: CANDIDATE_PRIORITY,
    routes: ["direct-http", "direct-https", "same-origin-api", "same-origin-socket"],
    oldApiDrain: {
      required: true,
      reason: "HYPER WireGuard GED relay remains on 127.0.0.1:8080 until separately moved and verified",
      relay: gedRelay,
    },
  };
}
