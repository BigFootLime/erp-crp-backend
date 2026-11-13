import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";

// Test-only capture of real PDFKit output, including renderers outside the shared kit.
vi.mock("pdfkit", async (original) => {
  const mod = await original<typeof import("pdfkit") & { default: typeof import("pdfkit") }>();
  const counters = new Map<string, number>();
  return { ...mod, default: class CapturedPdf extends mod.default {
    constructor(options?: PDFKit.PDFDocumentOptions) {
      super(options);
      const title = String(options?.info?.Title ?? "untitled");
      const test = expect.getState().currentTestName ?? "module-load";
      const key = `${test}|${title}`;
      const ordinal = (counters.get(key) ?? 0) + 1;
      counters.set(key, ordinal);
      const chunks: Buffer[] = [];
      this.on("data", (chunk: Buffer) => chunks.push(chunk));
      this.on("end", () => {
        const root = process.env.CERP_PDF_CAPTURE;
        if (!root || !chunks.length) return;
        mkdirSync(root, { recursive: true });
        const id = createHash("sha256").update(`${key}|${ordinal}`).digest("hex").slice(0, 20);
        writeFileSync(path.join(root, `${id}.pdf`), Buffer.concat(chunks));
        writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ test, title, ordinal }));
      });
    }
  } };
});
