import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

type InlineRow = { row_ref: string; file_base64: string | null; checksum: string | null };
type InlineResult = {
  reference_count: number;
  verified_count: number;
  total_bytes: number;
  failure_count: number;
  failures: Array<{ reference: string; reason: string }>;
};

function verify(rows: InlineRow[]): InlineResult {
  const moduleUrl = pathToFileURL(path.resolve(process.cwd(), "scripts/backup/recovery-set.mjs")).href;
  const source = `import { verifyInlineDocumentRows } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(verifyInlineDocumentRows(JSON.parse(process.argv[1]))));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(rows)], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(output) as InlineResult;
}

describe("SOL-10 inline document recovery integrity", () => {
  it("verifies the database-backed export payload and checksum", () => {
    const content = Buffer.from("CERP inline report proof", "utf8");
    const result = verify([{
      row_ref: "report-export-1",
      file_base64: content.toString("base64"),
      checksum: crypto.createHash("sha256").update(content).digest("hex"),
    }]);

    expect(result).toMatchObject({ reference_count: 1, verified_count: 1, total_bytes: content.length, failure_count: 0 });
  });

  it.each([
    { label: "missing payload", file_base64: null, checksum: "a".repeat(64), reason: "invalid_or_missing_base64" },
    { label: "invalid checksum", file_base64: Buffer.from("proof").toString("base64"), checksum: "bad", reason: "invalid_or_missing_checksum" },
    { label: "mismatched checksum", file_base64: Buffer.from("proof").toString("base64"), checksum: "a".repeat(64), reason: "checksum_mismatch" },
  ])("rejects $label", ({ file_base64, checksum, reason }) => {
    const result = verify([{ row_ref: "report-export-invalid", file_base64, checksum }]);

    expect(result.failure_count).toBe(1);
    expect(result.failures[0]?.reason).toBe(reason);
  });
});
