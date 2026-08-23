import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("GED-203 entity attachment contracts", () => {
  it("searches document metadata and every original version filename", () => {
    const repository = read("src/module/ged/repository/ged.repository.ts");
    expect(repository).toContain("lower(qv.original_name)");
    expect(repository).toContain("lower(COALESCE(d.description, ''))");
    expect(repository).toContain("filters.link_role");
    expect(repository).toContain("current_original_name");
  });

  it("authorizes the business parent before inspecting or promoting file content", () => {
    const service = read("src/module/ged/services/ged.service.ts");
    const upload = service.slice(service.indexOf("export async function uploadDocument"));
    const authorization = upload.indexOf("assertGedParentLinkWritable");
    const contentInspection = upload.indexOf("assertAcceptedFileOnDisk");
    const promotion = upload.indexOf("writeBlobFromPath");
    expect(authorization).toBeGreaterThan(-1);
    expect(authorization).toBeLessThan(contentInspection);
    expect(authorization).toBeLessThan(promotion);
  });

  it("keeps the parent registry closed while explicitly supporting gammes", () => {
    const authorization = read("src/module/ged/services/ged-parent-authorization.service.ts");
    const repository = read("src/module/ged/repository/ged.repository.ts");
    expect(authorization).toContain('GAMME: { moduleKey: "pieces-techniques"');
    expect(repository).toContain("SELECT 1 FROM public.gammes WHERE id = $1::uuid LIMIT 1");
    expect(repository).toContain("if (!statement) return false");
  });
});
