import crypto from "node:crypto";
import process from "node:process";

import { HttpError } from "../../../utils/httpError";
import { importQualifiedCatalogueTestOnly, loadQualifiedCatalogueDataset, resolveQualifiedDatasetPath } from "../services/outil-catalogue-test-import.service";

function argument(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] ?? null : null;
}

async function main() {
  const dataset = argument("--dataset");
  const expectedSha256 = argument("--sha256");
  const apply = process.argv.includes("--apply");
  if (!dataset || !expectedSha256 || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new HttpError(422, "CATALOGUE_IMPORT_USAGE", "Usage: --dataset <chemin absolu> --sha256 <sha256> [--apply]");
  }
  const filePath = resolveQualifiedDatasetPath(dataset);
  const actual = crypto.createHash("sha256").update(await (await import("node:fs/promises")).readFile(filePath)).digest("hex");
  if (actual !== expectedSha256.toLowerCase()) throw new HttpError(422, "CATALOGUE_IMPORT_DATASET_HASH_MISMATCH", "Le hash du jeu qualifié ne correspond pas.");
  if (apply && process.env.CERP_TOOL_CATALOGUE_TEST_IMPORT !== "true") {
    throw new HttpError(403, "CATALOGUE_IMPORT_APPLY_DISABLED", "Définissez CERP_TOOL_CATALOGUE_TEST_IMPORT=true pour écrire dans cerp_test.");
  }
  const report = await importQualifiedCatalogueTestOnly(await loadQualifiedCatalogueDataset(filePath), apply);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.rejected.length) process.exitCode = 2;
}
main().catch((error: unknown) => {
  const code = error instanceof HttpError ? error.code : "CATALOGUE_IMPORT_FAILED";
  const message = error instanceof Error ? error.message : "Import catalogue impossible";
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
});
