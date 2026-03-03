import { describe, it, expect, vi } from "vitest";
import request from "supertest";

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 1, role: "Administrateur Systeme et Reseau" };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import app from "../config/app";

describe("/api/v1/codes", () => {
  it("GET /api/v1/codes/formats returns items with regex/example/hintText", async () => {
    const res = await request(app).get("/api/v1/codes/formats");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);

    const client = res.body.items.find((it: any) => it.key === "client");
    expect(client).toBeTruthy();
    expect(typeof client.regex).toBe("string");
    expect(client.example).toBe("CLI-001");
    expect(String(client.hintText)).toContain("CLI-001");
  });
});
