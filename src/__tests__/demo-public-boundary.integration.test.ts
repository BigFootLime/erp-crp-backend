import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { demoAccessGuard, demoPublicBoundaryGuard } from "../middlewares/demo-access.middleware";

describe("CERP-DEMO-01 public boundary", () => {
  const previous = process.env.CERP_DEMO_MODE;

  afterEach(() => {
    if (previous === undefined) delete process.env.CERP_DEMO_MODE;
    else process.env.CERP_DEMO_MODE = previous;
  });

  function app() {
    const instance = express();
    instance.use(express.json());
    instance.use(demoPublicBoundaryGuard);
    instance.post("/auth/demo/login", (_req, res) => res.status(200).json({ token: "demo" }));
    // Represents the JWT middleware mounted after the public router block.
    instance.use((req, res, next) => req.header("authorization") === "Bearer demo" ? next() : res.sendStatus(401));
    instance.use(demoAccessGuard);
    instance.get("/stock/articles", (_req, res) => res.status(200).json({ ok: true }));
    instance.post("/devis", (_req, res) => res.status(200).json({ ok: true }));
    instance.post("/electronic-invoicing/webhooks/provider", (_req, res) => res.status(204).end());
    instance.get("/portal/orders", (_req, res) => res.status(200).json({ leaked: true }));
    return instance;
  }

  it("keeps protected main-module reads and scenario writes reachable", async () => {
    process.env.CERP_DEMO_MODE = "true";
    const headers = { Authorization: "Bearer demo", "X-CERP-Database": "cerp_demo" };
    await request(app()).get("/stock/articles").set(headers).expect(200);
    await request(app()).post("/devis").set(headers).send({ statut: "BROUILLON" }).expect(200);
    await request(app()).get("/stock/articles").set("Authorization", "Bearer demo").expect(403);
  });

  it("admits only the explicit visitor-login public route", async () => {
    process.env.CERP_DEMO_MODE = "true";
    await request(app()).post("/auth/demo/login").set("X-CERP-Database", "cerp_demo").expect(200);
    await request(app()).post("/auth/demo/login").expect(403);
  });

  it("blocks legacy public portal and webhook routes before JWT", async () => {
    process.env.CERP_DEMO_MODE = "true";
    await request(app()).post("/electronic-invoicing/webhooks/provider").set("X-CERP-Database", "cerp_demo").expect(403);
    await request(app()).get("/portal/orders").set("X-CERP-Database", "cerp_demo").expect(403);
    await request(app()).post("/time-clock/device-events").set("X-CERP-Database", "cerp_demo").expect(403);
    await request(app()).get("/terminals/bootstrap").set("X-CERP-Database", "cerp_demo").expect(403);
    await request(app()).post("/Electronic-Invoicing/Webhooks/provider").set("X-CERP-Database", "cerp_demo").expect(403);
    await request(app()).get("/PORTAL/orders").set("X-CERP-Database", "cerp_demo").expect(403);
  });
});
