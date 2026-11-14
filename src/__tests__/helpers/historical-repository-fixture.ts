import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

type HistoricalRepositoryFixture = "commandeClientBeforeCreation" | "deliveryListBeforeExtraction";

// These read-only snapshots come from published official history. Tests must
// also work in a shallow clone or source archive without a local Git database.
export function readHistoricalRepositoryFixture(name: HistoricalRepositoryFixture): string {
  const directory = path.join(process.cwd(), "src/__tests__/fixtures/repository-history");
  const provenance = JSON.parse(readFileSync(path.join(directory, "provenance.json"), "utf8")) as Record<
    HistoricalRepositoryFixture,
    { file: string; fixtureSha256: string }
  >;
  const fixture = provenance[name];
  const source = readFileSync(path.join(directory, fixture.file), "utf8");
  if (createHash("sha256").update(source).digest("hex") !== fixture.fixtureSha256) {
    throw new Error(`Historical repository fixture integrity mismatch: ${name}`);
  }
  return source;
}
