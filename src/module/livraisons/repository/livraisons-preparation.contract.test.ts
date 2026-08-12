import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { repoRoot } from "../../../__tests__/helpers/repo-paths"

const preparationSource = readFileSync(
  resolve(repoRoot, "src/module/livraisons/repository/livraisons-preparation.repository.ts"),
  "utf8"
)
const shipmentSource = readFileSync(
  resolve(repoRoot, "src/module/livraisons/repository/livraisons-shipment.repository.ts"),
  "utf8"
)

describe("delivery physical preparation contract", () => {
  it("persists append-only confirmations with idempotency, audit and realtime invalidation", () => {
    expect(preparationSource).toContain("PICK_CONFIRMED")
    expect(preparationSource).toContain("PICK_RESET")
    expect(preparationSource).toContain("pg_advisory_xact_lock")
    expect(preparationSource).toContain("livraisons.pick.confirmed")
    expect(preparationSource).toContain("enqueueEntityChanged")
  })

  it("makes an unconfirmed pick a server-side shipment blocker and hashes the pick state", () => {
    expect(shipmentSource).toContain("PREPARATION_CONFIRMATION_REQUIRED")
    expect(shipmentSource).toMatch(/enforcePicking\s*&&\s*!allocation\.pick_confirmed/)
    expect(shipmentSource).toContain("pick_confirmed:")
    expect(shipmentSource).toContain("buildPreview(snapshot, qualityRelease, true, true)")
  })
})
