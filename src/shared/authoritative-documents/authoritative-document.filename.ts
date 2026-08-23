/**
 * Files in the GED are an interface, not a storage key. Keep filenames stable,
 * printable and safe across Windows, Linux and archive exports.
 */
export function authoritativePdfFilename(parts: readonly string[]): string {
  const normalized = parts
    .map((value) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""))
    .map((value) => value.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-")
    .slice(0, 176);
  return `${normalized || "document"}.pdf`;
}

export function assertAuthoritativePdfFilename(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.pdf$/.test(value)) {
    throw new Error("AUTHORITATIVE_PDF_FILENAME_INVALID");
  }
}
