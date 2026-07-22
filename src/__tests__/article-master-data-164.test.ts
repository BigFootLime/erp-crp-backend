import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  archiveArticleSchema,
  createArticleSchema,
  reactivateArticleSchema,
  updateArticleSchema,
} from "../module/stock/validators/stock.validators"
import { canViewArticleCosts } from "../module/stock/stock-article.permissions"

const validPurchasingCases = Array.from({ length: 40 }, (_, index) => ({
  designation: `Article approvisionné ${index}`,
  article_category: "achat" as const,
  article_categories: [index % 2 ? "achat_revente" as const : "achat_transforme" as const],
  family_code: `ACH${index}`,
  stock_managed: index % 3 !== 0,
  lot_tracking: false,
  is_sold: index % 2 === 0,
  procurement: {
    manufacturer_name: `Fabricant ${index}`,
    manufacturer_reference: `REF-${index}`,
    min_stock: index,
    max_stock: index + 10,
    certificate_required: index % 2 === 0,
  },
}))

const validMaterialCases = Array.from({ length: 20 }, (_, index) => ({
  designation: `Matière ${index}`,
  article_category: "matiere" as const,
  article_categories: ["matiere_premiere" as const],
  family_code: "MAT",
  article_matiere: index % 2 === 0
    ? { barre_a_decouper: true, longueur_unitaire_mm: index + 1, largeur_mm: 10 }
    : { barre_a_decouper: false, longueur_mm: index + 1, diametre_mm: 12 },
}))

describe("#164 Article master-data validation matrix", () => {
  it.each(validPurchasingCases)("accepts purchasing master-data case %#", (body) => {
    const parsed = createArticleSchema.safeParse({ body })
    expect(parsed.success).toBe(true)
  })

  it.each(validMaterialCases)("accepts material geometry case %#", (body) => {
    const parsed = createArticleSchema.safeParse({ body })
    expect(parsed.success).toBe(true)
  })

  it.each(Array.from({ length: 20 }, (_, index) => index))("rejects client supplied Article code case %#", (index) => {
    const parsed = createArticleSchema.safeParse({
      body: { code: `FORCED-${index}`, designation: "Injection interdite", family_code: "ACH" },
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects client-supplied technical version fields", () => {
    expect(createArticleSchema.safeParse({
      body: { designation: "Indice injecté", family_code: "ACH", version_number: 2 },
    }).success).toBe(false)
    expect(createArticleSchema.safeParse({
      body: { designation: "Plan injecté", family_code: "ACH", plan_index: 3 },
    }).success).toBe(false)
  })

  it.each(Array.from({ length: 20 }, (_, index) => index))("rejects lot tracking without stock case %#", (index) => {
    const parsed = createArticleSchema.safeParse({
      body: { designation: `Lot invalide ${index}`, family_code: "ACH", stock_managed: false, lot_tracking: true },
    })
    expect(parsed.success).toBe(false)
  })

  it.each(Array.from({ length: 20 }, (_, index) => index))("rejects incoherent procurement thresholds case %#", (index) => {
    const parsed = createArticleSchema.safeParse({
      body: { designation: `Seuil invalide ${index}`, family_code: "ACH", procurement: { min_stock: 20 + index, max_stock: index } },
    })
    expect(parsed.success).toBe(false)
  })

  it("requires optimistic locking and keeps code outside the update contract", () => {
    expect(updateArticleSchema.safeParse({ body: { designation: "X" } }).success).toBe(false)
    expect(updateArticleSchema.safeParse({ body: { expected_row_version: 1, code: "FORCED" } }).success).toBe(false)
    expect(updateArticleSchema.safeParse({ body: { expected_row_version: 1, designation: "Désignation corrigée" } }).success).toBe(true)
  })

  it("requires row versions on archive and reactivation", () => {
    expect(archiveArticleSchema.safeParse({ body: { expected_row_version: 2, reason: "Obsolète" } }).success).toBe(true)
    expect(archiveArticleSchema.safeParse({ body: {} }).success).toBe(false)
    expect(reactivateArticleSchema.safeParse({ body: { expected_row_version: 3 } }).success).toBe(true)
  })

  it("redacts supplier costs outside the explicit role allow-list", () => {
    expect(canViewArticleCosts("Directeur")).toBe(true)
    expect(canViewArticleCosts("Secretaire")).toBe(true)
    expect(canViewArticleCosts("Operateur")).toBe(false)
    expect(canViewArticleCosts(undefined)).toBe(false)
  })

  it("ships immutable-code, idempotence and test-only rollback guards", () => {
    const patch = fs.readFileSync(path.resolve("db/patches/20260722_articles_164_master_data.sql"), "utf8")
    const rollback = fs.readFileSync(path.resolve("db/patches/support/20260722_articles_164_master_data.rollback.sql"), "utf8")
    expect(patch).toContain("ARTICLE_CODE_IMMUTABLE")
    expect(patch).toContain("article_create_idempotence")
    expect(patch).toContain("row_version")
    expect(rollback).toContain("current_database() <> 'cerp_test'")
  })
})
