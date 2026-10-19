import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../services/payment-modes.service", () => ({
  svcCreatePaymentMode: dependencies.create,
  svcListPaymentModes: dependencies.list,
}));

import { postPaymentMode } from "./payment-modes.controller";

beforeEach(() => vi.clearAllMocks());

function response() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("postPaymentMode", () => {
  it("accepts the existing valid payload and keeps an SQL-shaped value as data", async () => {
    dependencies.create.mockResolvedValue({ id: "mode-1" });
    const res = response();
    const next = vi.fn();

    await postPaymentMode({ body: { name: "Virement ' OR 1=1 --", code: "VIR", notes: "30 jours", ignored: true }, user: { username: "KEENAN" } } as any, res as any, next);

    expect(dependencies.create).toHaveBeenCalledWith({ name: "Virement ' OR 1=1 --", code: "VIR", notes: "30 jours", createdBy: "KEENAN" });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes internal failures to the central error handler without sending their message", async () => {
    dependencies.create.mockRejectedValue(new Error("database password must stay private"));
    const res = response();
    const next = vi.fn();

    await postPaymentMode({ body: { name: "Virement" }, user: {} } as any, res as any, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "database password must stay private" }));
    expect(res.send).not.toHaveBeenCalled();
  });

  it("rejects malformed or oversized values before reaching the service", async () => {
    const res = response();
    const next = vi.fn();

    await postPaymentMode({ body: { name: "x".repeat(256) }, user: {} } as any, res as any, next);

    expect(dependencies.create).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "PAYMENT_MODE_INPUT_INVALID", status: 400 }));
  });
});
