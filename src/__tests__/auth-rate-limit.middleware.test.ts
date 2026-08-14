import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthRateLimitDecision } from "../module/auth/domain/auth-rate-limit";
import { createAuthRateLimitMiddleware } from "../module/auth/middlewares/auth-rate-limit.middleware";

function appWithDecision(endpoint: Parameters<typeof createAuthRateLimitMiddleware>[0], decision: AuthRateLimitDecision) {
  const checkedSubjects: unknown[][] = [];
  const limiter = {
    check: vi.fn(async (_endpoint, subjects) => {
      checkedSubjects.push([...subjects]);
      return decision;
    }),
  };
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.post(
    "/auth",
    createAuthRateLimitMiddleware(endpoint, limiter as never),
    (req, res) => res.status(200).json({
      message: "Si ce compte existe, un lien de réinitialisation a été envoyé.",
      suppressed: req.authRateLimit?.suppressAction ?? false,
    })
  );
  return { app, limiter, checkedSubjects };
}

afterEach(() => vi.restoreAllMocks());

describe("auth rate limit middleware", () => {
  it("limits electronic-invoice webhooks by client address without reading signed payload fields", async () => {
    const { app, checkedSubjects } = appWithDecision("einvoiceWebhook", {
      status: "allowed",
      endpoint: "einvoiceWebhook",
      disabled: false,
    });

    const response = await request(app)
      .post("/auth")
      .set("X-Forwarded-For", "198.51.100.26")
      .send({ invoice: "must-not-become-a-rate-limit-subject" });

    expect(response.status).toBe(200);
    expect(checkedSubjects).toEqual([[{ dimension: "ip", value: "ipv4:198.51.100.26" }]]);
  });

  it("returns a generic 429 with Retry-After for an explicit login block", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = appWithDecision("login", {
      status: "blocked",
      endpoint: "login",
      retryAfterSeconds: 37,
    });

    const response = await request(app).post("/auth").send({ username: "operator", password: "wrong" });

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("37");
    expect(response.body).toEqual({
      error: "TOO_MANY_ATTEMPTS",
      message: "Trop de tentatives. Réessayez plus tard.",
    });
  });

  it("suppresses forgot-password work while preserving the generic 200 response", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = appWithDecision("forgotPassword", {
      status: "blocked",
      endpoint: "forgotPassword",
      retryAfterSeconds: 55,
    });

    const response = await request(app)
      .post("/auth")
      .send({ usernameOrEmail: "person@example.test" });

    expect(response.status).toBe(200);
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(response.body).toEqual({
      message: "Si ce compte existe, un lien de réinitialisation a été envoyé.",
      suppressed: true,
    });
  });

  it("fails closed with a generic 503 when the shared store is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = appWithDecision("register", {
      status: "unavailable",
      endpoint: "register",
      failurePolicy: "closed-error",
      retryAfterSeconds: 19,
      errorName: "Error",
    });

    const response = await request(app).post("/auth").send({ username: "new-user" });

    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("19");
    expect(response.body).toEqual({
      error: "AUTH_TEMPORARILY_UNAVAILABLE",
      message: "Service d'authentification temporairement indisponible.",
    });
  });

  it("uses the nearest proxy hop and canonicalizes IPv4-mapped addresses", async () => {
    const { app, limiter, checkedSubjects } = appWithDecision("login", {
      status: "allowed",
      endpoint: "login",
      disabled: false,
    });

    await request(app)
      .post("/auth")
      .set("X-Forwarded-For", "198.51.100.9, ::ffff:203.0.113.7")
      .send({ username: "operator" })
      .expect(200);

    expect(limiter.check).toHaveBeenCalledTimes(1);
    expect(checkedSubjects[0]).toEqual([
      { dimension: "ip", value: "ipv4:203.0.113.7" },
      { dimension: "username", value: "OPERATOR" },
    ]);
  });

  it("always consumes both canonical forgot-password identity candidates", async () => {
    const { app, checkedSubjects } = appWithDecision("forgotPassword", {
      status: "allowed",
      endpoint: "forgotPassword",
      disabled: false,
    });

    const responses = [];
    for (const identifier of ["stra\u00dfe", "Person@Example.Test", "unknown-account"]) {
      responses.push(
        await request(app)
          .post("/auth")
          .send({ usernameOrEmail: identifier })
      );
    }

    expect(responses.map((response) => [response.status, response.body])).toEqual([
      [200, expect.objectContaining({ suppressed: false })],
      [200, expect.objectContaining({ suppressed: false })],
      [200, expect.objectContaining({ suppressed: false })],
    ]);
    expect(checkedSubjects).toEqual([
      [
        { dimension: "ip", value: "ipv4:127.0.0.1" },
        { dimension: "username", value: "STRASSE" },
        { dimension: "email", value: "stra\u00dfe" },
      ],
      [
        { dimension: "ip", value: "ipv4:127.0.0.1" },
        { dimension: "username", value: "PERSON@EXAMPLE.TEST" },
        { dimension: "email", value: "person@example.test" },
      ],
      [
        { dimension: "ip", value: "ipv4:127.0.0.1" },
        { dimension: "username", value: "UNKNOWN-ACCOUNT" },
        { dimension: "email", value: "unknown-account" },
      ],
    ]);
  });

  it("passes an opaque reset token without trimming or case folding", async () => {
    const { app, checkedSubjects } = appWithDecision("resetPassword", {
      status: "allowed",
      endpoint: "resetPassword",
      disabled: false,
    });

    await request(app)
      .post("/auth")
      .send({ token: " AbC-opaque-token " })
      .expect(200);

    expect(checkedSubjects[0]).toEqual([
      { dimension: "ip", value: "ipv4:127.0.0.1" },
      { dimension: "token", value: " AbC-opaque-token " },
    ]);
  });

  it("never emits request subjects in rate-limit observability logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = appWithDecision("forgotPassword", {
      status: "unavailable",
      endpoint: "forgotPassword",
      failurePolicy: "closed-generic",
      retryAfterSeconds: 19,
      errorName: "Error",
    });

    await request(app)
      .post("/auth")
      .set("X-Forwarded-For", "198.51.100.44")
      .send({ usernameOrEmail: "person@example.test" })
      .expect(200);

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain("198.51.100.44");
    expect(logged).not.toContain("person@example.test");
    expect(logged).toContain("store_unavailable");
  });
});
