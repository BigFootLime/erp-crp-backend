import { z } from "zod"

import { HttpError } from "./httpError"

export function uuidRouteParam(name: string) {
  return z
    .string({
      required_error: `Le paramètre de route "${name}" est requis`,
      invalid_type_error: `Le paramètre de route "${name}" doit être fourni une seule fois sous forme de chaîne`,
    })
    .uuid(`Le paramètre de route "${name}" doit être un UUID valide`)
}

/**
 * Narrows the Express 5 route-param union only after runtime UUID validation.
 * Missing params and wildcard arrays are rejected before reaching services.
 */
export function parseUuidRouteParam(params: Readonly<Record<string, unknown>>, name: string): string {
  const parsed = uuidRouteParam(name).safeParse(params[name])
  if (!parsed.success) {
    throw new HttpError(
      400,
      "INVALID_ROUTE_PARAM",
      parsed.error.issues[0]?.message ?? `Le paramètre de route "${name}" est invalide`
    )
  }
  return parsed.data
}
