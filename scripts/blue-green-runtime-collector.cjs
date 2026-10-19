function traefikRouterLabels(labels) {
  const prefix = "traefik.http.routers.";
  const routers = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length), dot = suffix.lastIndexOf(".");
    if (dot <= 0) continue;
    const name = suffix.slice(0, dot), field = suffix.slice(dot + 1);
    if (!["rule", "priority", "service"].includes(field)) continue;
    (routers[name] ??= {})[field] = value;
  }
  return routers;
}

function redactUpstreamUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return undefined; }
}

module.exports = { traefikRouterLabels, redactUpstreamUrl };
