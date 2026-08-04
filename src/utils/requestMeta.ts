import type { Request } from "express";
import net from "node:net";

export function getClientIp(req: Request): string | null {
  // Avec trust proxy, req.ip est ok
  return req.ip || (req.socket?.remoteAddress ?? null);
}

function canonicalIpv6Groups(value: string): number[] | null {
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    const canonical = hostname.slice(1, -1);
    const parts = canonical.split("::");
    if (parts.length > 2) return null;

    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts[1] ? parts[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0 || (parts.length === 1 && missing !== 0)) return null;

    const groups = [
      ...left,
      ...Array.from({ length: missing }, () => "0"),
      ...right,
    ].map((part) => Number.parseInt(part || "0", 16));

    return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
      ? groups
      : null;
  } catch {
    return null;
  }
}

/**
 * Produces a stable abuse-prevention subject, not a value suitable for logs.
 * IPv4-mapped IPv6 addresses collapse to IPv4 and native IPv6 addresses are
 * grouped by /64 so alternate textual forms and privacy addresses share a key.
 */
export function canonicalizeRateLimitClientAddress(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const withoutZone = trimmed.split("%", 1)[0] ?? "";
  if (net.isIPv4(withoutZone)) {
    return `ipv4:${withoutZone.split(".").map((part) => Number.parseInt(part, 10)).join(".")}`;
  }
  if (!net.isIPv6(withoutZone)) return null;

  const groups = canonicalIpv6Groups(withoutZone);
  if (!groups) return null;

  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isIpv4Mapped) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    const ipv4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    return `ipv4:${ipv4}`;
  }

  const prefix = groups.slice(0, 4).map((group) => group.toString(16)).join(":");
  return `ipv6:${prefix}::/64`;
}

export function getRateLimitClientAddress(req: Request): string | null {
  return canonicalizeRateLimitClientAddress(getClientIp(req));
}

export function parseDevice(userAgent?: string | null) {
  const ua = (userAgent || "").toLowerCase();

  const device_type =
    ua.includes("mobile") || ua.includes("android") || ua.includes("iphone")
      ? "mobile"
      : ua.includes("ipad") || ua.includes("tablet")
        ? "tablet"
        : ua.length ? "desktop" : "unknown";

  const os =
    ua.includes("windows") ? "Windows" :
    ua.includes("mac os") || ua.includes("macintosh") ? "macOS" :
    ua.includes("android") ? "Android" :
    ua.includes("iphone") || ua.includes("ipad") ? "iOS" :
    ua.includes("linux") ? "Linux" : "Unknown";

  const browser =
    ua.includes("edg/") ? "Edge" :
    ua.includes("chrome/") && !ua.includes("edg/") ? "Chrome" :
    ua.includes("firefox/") ? "Firefox" :
    ua.includes("safari/") && !ua.includes("chrome/") ? "Safari" :
    "Unknown";

  return { device_type, os, browser };
}
