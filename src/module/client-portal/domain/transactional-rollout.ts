import type { RequestHandler } from "express";

/** Business writes are opened separately from the consultation portal. */
export function clientTransactionsEnabled(): boolean {
  if (process.env.CERP_CLIENT_PORTAL_TRANSACTIONS === "1") return true;
  if (process.env.NODE_ENV !== "test" || process.env.CERP_E2E_ISOLATED !== "1") return false;
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname === "/cerp_test";
  } catch { return false; }
}

export const requireClientTransactions: RequestHandler = (_req, res, next) => {
  if (!clientTransactionsEnabled()) {
    res.status(404).json({ code: "PORTAL_TRANSACTIONS_UNAVAILABLE", message: "Service indisponible." });
    return;
  }
  next();
};
