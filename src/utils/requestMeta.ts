import type { Request } from "express";

export function getClientIp(req: Request): string | null {
  // Avec trust proxy, req.ip est ok
  return req.ip || (req.socket?.remoteAddress ?? null);
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
