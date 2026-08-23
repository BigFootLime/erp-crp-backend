import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.resolve(root, file), "utf8");
function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? tsFiles(path.join(dir, entry.name))
    : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path.join(dir, entry.name)] : []);
}

describe("#624 delivery formal-document writer coverage", () => {
  const manifest = JSON.parse(read("docs/contracts/formal-document-writers.json")) as {
    canonical_archive: { creation_kind: string; shipped_kind: string };
    writers: Array<{ source: string; entry: string; transactional_queue: string }>;
  };

  it("classifies every mounted POST and direct delivery writer", () => {
    const routes = read("src/module/livraisons/routes/livraisons.routes.ts");
    const direct = read("src/module/commande-client/repository/commande-client.repository.ts");
    expect(manifest.writers).toHaveLength(4);
    for (const writer of manifest.writers) {
      expect(read(writer.source)).toContain(writer.entry);
      expect(writer.transactional_queue).toBeTruthy();
    }
    expect(routes).toContain('router.post("/", requireLivraisonCapability("prepare"), createLivraison)');
    expect(routes).toContain('"/from-commande/:commandeId"');
    expect(direct).toContain("repoCreateLivraisonFromCommande(");
  });

  it("fails closed when a new production direct INSERT writer is not classified", () => {
    const writers = new Set(manifest.writers.map((writer) => writer.source.replaceAll("/", path.sep)));
    const directInserts = tsFiles(path.resolve(root, "src"))
      .filter((file) => /INSERT\s+INTO\s+(?:public\.)?bon_livraison\s*\(/i.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));
    expect(directInserts).toEqual(expect.arrayContaining(["src/module/livraisons/repository/livraisons.repository.ts".replaceAll("/", path.sep)]));
    for (const writer of directInserts) expect(writers).toContain(writer);
  });

  it("keeps both repository create paths queueing before their transaction returns and shipment issuing the official artifact", () => {
    const repository = read("src/module/livraisons/repository/livraisons.repository.ts");
    const shipment = read("src/module/livraisons/repository/livraisons-shipment.repository.ts");
    for (const marker of ["export async function repoCreateLivraison(", "export async function repoCreateLivraisonFromCommande("]) {
      const start = repository.indexOf(marker);
      const body = repository.slice(start, repository.indexOf("\nexport ", start + marker.length));
      expect(body).toContain("queueCreationPdfArchive");
      expect(body).toContain("buildDeliveryCreationSnapshotInput");
    }
    expect(shipment).toContain("buildShippedDeliveryArtifactInput");
    expect(shipment).toContain("queueCreationPdfArchive");
    expect(manifest.canonical_archive).toMatchObject({ creation_kind: "DELIVERY_NOTE_CREATION_SNAPSHOT", shipped_kind: "DELIVERY_NOTE_SHIPPED" });
  });
});
