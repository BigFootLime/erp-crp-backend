import { AsyncLocalStorage } from "node:async_hooks";

export const PDF_CHARTER_SUFFIX = "+module-v1";
export type PdfModule = "commerce" | "production" | "qualite" | "stock" | "outillage" | "systeme";
export const PDF_MODULE_ACCENTS: Readonly<Record<PdfModule, string>> = {
  commerce: "#2563EB", production: "#0F766E", qualite: "#B45309",
  stock: "#6D28D9", outillage: "#C1121F", systeme: "#4B5560",
};
type PdfPresentation = { legacy: boolean; module: PdfModule };
const presentation = new AsyncLocalStorage<PdfPresentation>();

export function pdfModuleForEntity(entity: string): PdfModule {
  if (["ordre-fabrication","piece-technique","piece-technique-version"].includes(entity)) return "production";
  if (entity === "stock-article") return "stock";
  if (["qualite","asbuilt"].includes(entity)) return "qualite";
  if (entity === "outillage") return "outillage";
  if (["project-office","temps-deplacements"].includes(entity)) return "systeme";
  return "commerce";
}

export function pdfModuleForDocument(type: string): PdfModule {
  const key = type.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/qualite|conformite|as.built|autocontrole|controle|lot/.test(key)) return "qualite";
  if (/fabrication|technique|piece|suiveuse|production|preparation/.test(key)) return "production";
  if (/stock|article|conditionnement/.test(key)) return "stock";
  if (/outil/.test(key)) return "outillage";
  if (/projet|statut|paie|temps|rapport/.test(key)) return "systeme";
  return "commerce";
}

export const basePdfRenderVersion = (value: string): string => value.endsWith(PDF_CHARTER_SUFFIX) ? value.slice(0, -PDF_CHARTER_SUFFIX.length) : value;
export function modulePdfRenderVersion(value: string): string {
  const result = basePdfRenderVersion(value) + PDF_CHARTER_SUFFIX;
  if (result.length > 64) throw new Error("PDF_RENDER_VERSION_TOO_LONG");
  return result;
}
export function withArchivePdfPresentation<T>(entity: string, renderVersion: string, render: () => T): T {
  return presentation.run({ legacy: !renderVersion.endsWith(PDF_CHARTER_SUFFIX), module: pdfModuleForEntity(entity) }, render);
}
export function currentPdfPresentation(type: string, explicitModule?: PdfModule): PdfPresentation {
  const active = presentation.getStore();
  return active ?? { legacy: false, module: explicitModule ?? pdfModuleForDocument(type) };
}
