import type { RequestHandler } from "express";

export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const payload = {
      type: "http_request",
      requestId: req.requestId ?? null,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs,
      origin: req.headers.origin ?? null,
      userId: req.user?.id ?? null,
    };

    // Structured log (ISO traceability). No secrets.
    console.log(JSON.stringify(payload));
  });

  next();
};
