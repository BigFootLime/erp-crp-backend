import { z } from "zod";

export const commercialTermsScopeSchema = z.enum([
  "devis",
  "commande-client",
  "commande-fournisseur",
]);
export type CommercialTermsScope = z.infer<typeof commercialTermsScopeSchema>;
export const generalTermsSnapshotSchema = z.object({
  kind: z.enum(["CGV", "CGA"]),
  document_id: z.string().uuid(),
  version_id: z.string().uuid(),
  code: z.string().min(1),
  title: z.string().min(1),
  version_number: z.number().int().positive(),
  filename: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size_bytes: z.number().int().positive(),
});
export type GeneralTermsSnapshot = z.infer<typeof generalTermsSnapshotSchema>;
export const selectGeneralTermsSchema = z
  .object({
    version_id: z.string().uuid(),
    expected_selection_id: z.string().uuid().nullable(),
    reason: z.string().trim().min(3).max(500),
    idempotency_key: z.string().uuid(),
  })
  .strict();
export function termsKind(scope: CommercialTermsScope): "CGV" | "CGA" {
  return scope === "commande-fournisseur" ? "CGA" : "CGV";
}
export function generalTermsReference(value: unknown): string | null {
  if (value == null) return null;
  const terms = generalTermsSnapshotSchema.parse(value);
  return `${terms.kind} : ${terms.title} · ${terms.code} · version ${terms.version_number}\nDocument joint : ${terms.filename}\nSHA-256 : ${terms.sha256}`;
}
