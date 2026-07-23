import { describe, expect, it } from "vitest";

import { roleHasStockCapability } from "./stock-rbac";

describe("stock RBAC", () => {
  it("fails closed for an absent or unknown role", () => {
    expect(roleHasStockCapability(undefined, "read")).toBe(false);
    expect(roleHasStockCapability("Role sans habilitation", "movement_create")).toBe(false);
  });

  it("grants every critical capability to administrators", () => {
    expect(roleHasStockCapability("Administrateur Systeme et Reseau", "movement_post")).toBe(true);
    expect(roleHasStockCapability("Administrateur Systeme et Reseau", "negative_stock_override")).toBe(true);
    expect(roleHasStockCapability("Administrateur Systeme et Reseau", "inventory_close")).toBe(true);
  });

  it("separates quality decisions from stock posting", () => {
    expect(roleHasStockCapability("Responsable Qualité", "lot_quality")).toBe(true);
    expect(roleHasStockCapability("Responsable Qualité", "movement_post")).toBe(false);
  });

  it("lets employees read and count but not approve or post", () => {
    expect(roleHasStockCapability("Employee", "read")).toBe(true);
    expect(roleHasStockCapability("Employee", "inventory_count")).toBe(true);
    expect(roleHasStockCapability("Employee", "inventory_approve")).toBe(false);
    expect(roleHasStockCapability("Employee", "movement_post")).toBe(false);
  });
});
