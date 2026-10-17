import { EventEmitter } from "node:events";
import type { Request, Response, NextFunction } from "express";
import { describe, expect, it, vi } from "vitest";
import { createRequestBudget, isExpensiveRequest } from "../middlewares/request-budget";
function response() {
  return Object.assign(new EventEmitter(), { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() });
}
const req = (path = "/clients", type = "") => ({ method: "GET", path, headers: { "content-type": type } }) as Request;
describe("bounded admission of resource-intensive requests", () => {
  it("bounds concurrent multipart and PDF/export work while preserving ordinary reads", () => {
    const guard = createRequestBudget({ CERP_HTTP_MAX_IN_FLIGHT: "3", CERP_HTTP_HEAVY_MAX_IN_FLIGHT: "1" });
    const first = response(), second = response(), normal = response(), next = vi.fn();
    guard(req("/ged", "multipart/form-data; boundary=fixture"), first as unknown as Response, next);
    guard(req("/factures/42/pdf"), second as unknown as Response, next);
    expect(second.status).toHaveBeenCalledWith(429); expect(second.setHeader).toHaveBeenCalledWith("Retry-After", "5");
    guard(req(), normal as unknown as Response, next); expect(next).toHaveBeenCalledTimes(2);
    first.emit("finish"); first.emit("close");
    guard(req("/exports"), response() as unknown as Response, next); expect(next).toHaveBeenCalledTimes(3);
    guard(req("/imports"), response() as unknown as Response, next); expect(next).toHaveBeenCalledTimes(3);
  });
  it("caps ordinary work too and frees exactly one slot after a disconnect", () => {
    const guard = createRequestBudget({ CERP_HTTP_MAX_IN_FLIGHT: "1" });
    const first = response(), denied = response(), next: NextFunction = vi.fn();
    guard(req(), first as unknown as Response, next);
    guard(req(), denied as unknown as Response, next); expect(denied.status).toHaveBeenCalledWith(429);
    first.emit("close"); first.emit("finish");
    guard(req(), response() as unknown as Response, next); expect(next).toHaveBeenCalledTimes(2);
  });
  it("rejects unsafe configuration and classifies encoded payloads by content type", () => {
    for (const value of ["0", "-1", "NaN", "1.2", "99999"]) expect(() => createRequestBudget({ CERP_HTTP_MAX_IN_FLIGHT: value })).toThrow();
    expect(isExpensiveRequest(req("/avatar", "Multipart/Form-Data; boundary=fixture"))).toBe(true);
    expect(isExpensiveRequest(req("/clients/42"))).toBe(false);
  });
});
