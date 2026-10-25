import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDefaultToolCatalogueRoot,
  getToolCatalogueAsset,
  getToolCatalogueBundle,
} from "./outil-catalogue.service";

const roots: string[] = [];

async function catalogueRoot(manifest: unknown, assets: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-outillage-catalogue-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(path.join(root, "selection-jmt.json"), JSON.stringify(manifest));
  await Promise.all(Object.entries(assets).map(([name, body]) => fs.writeFile(path.join(root, "assets", name), body)));
  process.env.CERP_TOOL_CATALOGUE_ROOT = root;
  return root;
}

afterEach(async () => {
  delete process.env.CERP_TOOL_CATALOGUE_ROOT;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const validManifest = {
  schemaVersion: 1,
  entries: [{
    id: "source-1",
    imageUrl: "/tooling/catalogues/series.jpg",
    sketchUrl: null,
    source: {
      previewUrl: "/tooling/catalogues/page.png",
      cropUrl: null,
    },
  }],
};

describe("outil catalogue private source service", () => {
  it("rewrites only validated manifest assets to authenticated API paths", async () => {
    await catalogueRoot(validManifest, { "series.jpg": "jpg", "page.png": "png" });

    const bundle = await getToolCatalogueBundle();
    const entry = (bundle.entries as Array<Record<string, unknown>>)[0];
    expect(entry.imageUrl).toBe("/outils/catalogue/assets/series.jpg");
    expect((entry.source as Record<string, unknown>).previewUrl).toBe("/outils/catalogue/assets/page.png");
    expect(JSON.stringify(bundle)).not.toContain("/tooling/catalogues/");
  });

  it("returns only allowlisted regular assets referenced by the manifest", async () => {
    await catalogueRoot(validManifest, { "series.jpg": "jpg", "page.png": "png", "other.jpg": "other" });

    await expect(getToolCatalogueAsset("series.jpg")).resolves.toMatchObject({ contentType: "image/jpeg" });
    await expect(getToolCatalogueAsset("other.jpg")).rejects.toMatchObject({ status: 404, code: "OUTILLAGE_CATALOGUE_ASSET_NOT_FOUND" });
    await expect(getToolCatalogueAsset("../series.jpg")).rejects.toMatchObject({ status: 404, code: "OUTILLAGE_CATALOGUE_ASSET_NOT_FOUND" });
  });

  it("refuses an assets directory redirected through a symbolic link", async () => {
    const root = await catalogueRoot(validManifest, { "series.jpg": "jpg", "page.png": "png" });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-outillage-catalogue-outside-"));
    roots.push(outside);
    await fs.rm(path.join(root, "assets"), { recursive: true });
    await fs.symlink(outside, path.join(root, "assets"), "junction");

    await expect(getToolCatalogueAsset("series.jpg")).rejects.toMatchObject({ status: 404, code: "OUTILLAGE_CATALOGUE_ASSET_NOT_FOUND" });
  });

  it("fails closed when the manifest is absent or references an unsafe filename", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-outillage-catalogue-"));
    roots.push(root);
    process.env.CERP_TOOL_CATALOGUE_ROOT = root;
    await expect(getToolCatalogueBundle()).rejects.toMatchObject({ status: 503, code: "OUTILLAGE_CATALOGUE_UNAVAILABLE" });

    await catalogueRoot({ ...validManifest, entries: [{ ...validManifest.entries[0], imageUrl: "/tooling/catalogues/../secret.jpg" }] });
    await expect(getToolCatalogueBundle()).rejects.toMatchObject({ status: 503, code: "OUTILLAGE_CATALOGUE_UNAVAILABLE" });
  });

  it("keeps the default corpus outside frontend public files", () => {
    expect(getDefaultToolCatalogueRoot()).toMatch(/[\\/]resources[\\/]outillage-catalogue$/);
    expect(getDefaultToolCatalogueRoot()).not.toMatch(/[\\/]public([\\/]|$)/);
  });
});
