import { describe, expect, it } from "vitest"

import { gammeIdParamSchema, operationIdParamSchema, versionIdParamSchema as gammeVersionIdParamSchema } from "../module/gammes/validators/gammes.validators"
import { idParamSchema } from "../module/pieces-techniques/validators/pieces-techniques.validators"
import { versionIdParamSchema } from "../module/pieces-techniques/validators/versions.validators"
import { HttpError } from "../utils/httpError"
import { parseUuidRouteParam } from "../utils/routeParams"

const PIECE_ID = "11111111-1111-4111-8111-111111111111"
const VERSION_ID = "22222222-2222-4222-8222-222222222222"
const GAMME_ID = "33333333-3333-4333-8333-333333333333"
const OPERATION_ID = "44444444-4444-4444-8444-444444444444"

describe("Paramètres de route UUID", () => {
  it("retourne uniquement une chaîne UUID validée", () => {
    expect(parseUuidRouteParam({ versionId: VERSION_ID }, "versionId")).toBe(VERSION_ID)
  })

  it.each([
    ["absent", {}],
    ["multiple", { versionId: [VERSION_ID, VERSION_ID] }],
    ["non UUID", { versionId: "version-A" }],
  ])("refuse un paramètre %s avec une erreur 400 actionnable", (_label, params) => {
    expect.assertions(4)
    try {
      parseUuidRouteParam(params, "versionId")
    } catch (error) {
      if (!(error instanceof Error)) throw error
      expect(error).toBeInstanceOf(HttpError)
      expect(error).toMatchObject({ status: 400, code: "INVALID_ROUTE_PARAM" })
      expect(error.message).toContain("versionId")
      expect(error.message).toMatch(/requis|une seule fois|UUID valide/)
    }
  })

  it("conserve les schémas de paramètres des routes gamme/version strictement UUID", () => {
    expect(gammeVersionIdParamSchema.safeParse({ params: { versionId: VERSION_ID } }).success).toBe(true)
    expect(gammeIdParamSchema.safeParse({ params: { gammeId: GAMME_ID } }).success).toBe(true)
    expect(operationIdParamSchema.safeParse({ params: { gammeId: GAMME_ID, operationId: OPERATION_ID } }).success).toBe(true)
    expect(idParamSchema.safeParse({ params: { id: PIECE_ID } }).success).toBe(true)
    expect(versionIdParamSchema.safeParse({ params: { id: PIECE_ID, versionId: VERSION_ID } }).success).toBe(true)

    expect(gammeIdParamSchema.safeParse({ params: { gammeId: [GAMME_ID] } }).success).toBe(false)
    expect(versionIdParamSchema.safeParse({ params: { id: PIECE_ID, versionId: "A" } }).success).toBe(false)
  })
})
