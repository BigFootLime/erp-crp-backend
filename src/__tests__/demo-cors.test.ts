import { describe, expect, it } from "vitest";

import { isCorsOriginAllowed } from "../config/cors-policy";

describe("CERP-DEMO-01 CORS", () => {
  it("does not inherit localhost origins in demo mode", () => {
    const origins = new Set(["https://demo.example.test"]);
    expect(isCorsOriginAllowed("https://demo.example.test", origins, true)).toBe(true);
    expect(isCorsOriginAllowed("http://localhost:5173", origins, true)).toBe(false);
    expect(isCorsOriginAllowed("http://localhost:5173", origins, false)).toBe(true);
  });
});
