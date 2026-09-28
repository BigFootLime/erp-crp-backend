import { describe, expect, it, vi } from "vitest";

import { demoAccessGuard, demoAuthGuard } from "../middlewares/demo-access.middleware";

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
}

describe("CERP-DEMO-01 API guard", () => {
  it("allows a main-module read and rejects an administration read", () => {
    const previous = process.env.CERP_DEMO_MODE;
    process.env.CERP_DEMO_MODE = "true";
    const next = vi.fn();
    demoAccessGuard({ method: "GET", path: "/stock/articles", headers: { "x-cerp-database": "cerp_demo" } } as any, response(), next);
    expect(next).toHaveBeenCalledOnce();
    const denied = response();
    demoAccessGuard({ method: "GET", path: "/admin/users", headers: { "x-cerp-database": "cerp_demo" } } as any, denied, vi.fn());
    expect(denied.status).toHaveBeenCalledWith(403);
    process.env.CERP_DEMO_MODE = previous;
  });

  it("allows dashboard and quality reads but denies document and export GET routes", () => {
    const previous = process.env.CERP_DEMO_MODE;
    process.env.CERP_DEMO_MODE = "true";
    const headers = { "x-cerp-database": "cerp_demo" };
    const next = vi.fn();
    demoAccessGuard({ method: "GET", path: "/qualite/dashboard", headers } as any, response(), next);
    demoAccessGuard({ method: "GET", path: "/dashboard-governance", headers } as any, response(), next);
    demoAccessGuard({ method: "GET", path: "/codes/formats", headers } as any, response(), next);
    expect(next).toHaveBeenCalledTimes(3);
    for (const path of [
      "/devis/1/documents/2/file",
      "/stock/articles/export.csv",
      "/production/ofs/1/document/preview.pdf",
      "/livraisons/1/pack/generate",
      "/clients/1/DOCUMENTS/EXPORT.XLSX",
    ]) {
      const denied = response();
      demoAccessGuard({ method: "GET", path, headers } as any, denied, vi.fn());
      expect(denied.status).toHaveBeenCalledWith(403);
    }
    if (previous === undefined) delete process.env.CERP_DEMO_MODE;
    else process.env.CERP_DEMO_MODE = previous;
  });

  it("allows only the quote form reference catalogues and document service status", () => {
    const previous = process.env.CERP_DEMO_MODE;
    process.env.CERP_DEMO_MODE = "true";
    const headers = { "x-cerp-database": "cerp_demo" };
    for (const path of ["/billers", "/payment-modes", "/conditions-paiement", "/compte-vente", "/service-status/documents", "/operational-media/capabilities"]) {
      const next = vi.fn();
      demoAccessGuard({ method: "GET", path, headers } as any, response(), next);
      expect(next).toHaveBeenCalledOnce();
    }
    for (const path of ["/billers/1", "/payment-modes/1", "/service-status/documents/download", "/operational-media/id/content"]) {
      const denied = response();
      demoAccessGuard({ method: "GET", path, headers } as any, denied, vi.fn());
      expect(denied.status).toHaveBeenCalledWith(403);
    }
    if (previous === undefined) delete process.env.CERP_DEMO_MODE;
    else process.env.CERP_DEMO_MODE = previous;
  });

  it("allows only draft quote creation and never a delete", () => {
    const previous = process.env.CERP_DEMO_MODE;
    process.env.CERP_DEMO_MODE = "true";
    const next = vi.fn();
    demoAccessGuard({ method: "POST", path: "/devis", body: { statut: "BROUILLON" }, headers: { "x-cerp-database": "cerp_demo" }, is: vi.fn(() => false) } as any, response(), next);
    demoAccessGuard({ method: "POST", path: "/devis", body: { statut: "draft" }, headers: { "x-cerp-database": "cerp_demo" }, is: vi.fn(() => false) } as any, response(), next);
    expect(next).toHaveBeenCalledTimes(2);
    const sent = response();
    demoAccessGuard({ method: "POST", path: "/devis", body: { statut: "ENVOYE" }, headers: { "x-cerp-database": "cerp_demo" }, is: vi.fn(() => false) } as any, sent, vi.fn());
    expect(sent.status).toHaveBeenCalledWith(403);
    const multipart = response();
    demoAccessGuard({ method: "POST", path: "/devis", body: { statut: "BROUILLON" }, headers: { "x-cerp-database": "cerp_demo" }, is: vi.fn(() => true) } as any, multipart, vi.fn());
    expect(multipart.status).toHaveBeenCalledWith(403);
    const denied = response();
    demoAccessGuard({ method: "DELETE", path: "/devis/1", headers: { "x-cerp-database": "cerp_demo" } } as any, denied, vi.fn());
    expect(denied.status).toHaveBeenCalledWith(403);
    process.env.CERP_DEMO_MODE = previous;
  });

  it("allows only the bounded execution and command-to-affaire scenario writes", () => {
    const previous = process.env.CERP_DEMO_MODE;
    process.env.CERP_DEMO_MODE = "true";
    const headers = { "x-cerp-database": "cerp_demo" };
    for (const path of [
      "/production/execution", "/production/execution/11111111-1111-4111-8111-111111111111/pause",
      "/production/execution/quantities", "/production/execution/operations/finish/preview",
      "/commandes/7/affaires/preview", "/commandes/7/generate-affaires", "/devis/7/convert-to-commande",
      "/clients/duplicate-check",
    ]) {
      const next = vi.fn();
      demoAccessGuard({ method: "POST", path, headers, is: vi.fn(() => false) } as any, response(), next);
      expect(next).toHaveBeenCalledOnce();
    }
    for (const path of ["/commandes/7", "/production/ofs/7/release", "/production/execution/unknown/pause"]) {
      const denied = response();
      demoAccessGuard({ method: "POST", path, headers, is: vi.fn(() => false) } as any, denied, vi.fn());
      expect(denied.status).toHaveBeenCalledWith(403);
    }
    if (previous === undefined) delete process.env.CERP_DEMO_MODE;
    else process.env.CERP_DEMO_MODE = previous;
  });

  it("permits only the native full-journey form writes", () => {
    const previous = process.env.CERP_DEMO_MODE;
    process.env.CERP_DEMO_MODE = "true";
    const headers = { "x-cerp-database": "cerp_demo" };
    for (const [method, path] of [
      ["POST", "/pieces-techniques"], ["POST", "/stock/articles"],
      ["POST", "/production/ofs/7/receipt"], ["POST", "/livraisons"],
      ["POST", "/livraisons/11111111-1111-4111-8111-111111111111/ship"],
      ["POST", "/quality-360/executions"], ["POST", "/quality-360/executions/11111111-1111-4111-8111-111111111111/decision"],
      ["POST", "/quality-360/plans"],
    ]) {
      const next = vi.fn();
      demoAccessGuard({ method, path, headers, is: vi.fn(() => false) } as any, response(), next);
      expect(next).toHaveBeenCalledOnce();
    }
    const finishNext = vi.fn();
    demoAccessGuard({ method: "PATCH", path: "/production/ofs/7", body: { statut: "TERMINE" }, headers, is: vi.fn(() => false) } as any, response(), finishNext);
    expect(finishNext).toHaveBeenCalledOnce();
    const arbitraryStatus = response();
    demoAccessGuard({ method: "PATCH", path: "/production/ofs/7", body: { statut: "ANNULE" }, headers, is: vi.fn(() => false) } as any, arbitraryStatus, vi.fn());
    expect(arbitraryStatus.status).toHaveBeenCalledWith(403);
    for (const path of ["/stock/lots", "/livraisons/11111111-1111-4111-8111-111111111111/status"]) {
      const denied = response();
      demoAccessGuard({ method: "POST", path, headers, is: vi.fn(() => false) } as any, denied, vi.fn());
      expect(denied.status).toHaveBeenCalledWith(403);
    }
    if (previous === undefined) delete process.env.CERP_DEMO_MODE;
    else process.env.CERP_DEMO_MODE = previous;
  });

  it("permits login and access-profile but blocks reset flows", () => {
    const previous = process.env.CERP_DEMO_MODE;
    process.env.CERP_DEMO_MODE = "true";
    const next = vi.fn();
    demoAuthGuard({ method: "POST", path: "/login" } as any, response(), next);
    demoAuthGuard({ method: "POST", path: "/demo/login" } as any, response(), next);
    demoAuthGuard({ method: "GET", path: "/access-profile", headers: { "x-cerp-database": "cerp_demo" } } as any, response(), next);
    expect(next).toHaveBeenCalledTimes(3);
    const denied = response();
    demoAuthGuard({ method: "POST", path: "/forgot-password" } as any, denied, vi.fn());
    expect(denied.status).toHaveBeenCalledWith(403);
    process.env.CERP_DEMO_MODE = previous;
  });
});
