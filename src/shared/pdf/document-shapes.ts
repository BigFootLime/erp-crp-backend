/** Rounded presentation within the original box bounds. Never changes cursor or text metrics. */
export function documentPanelPath(
  doc: PDFKit.PDFDocument,
  x: number, y: number, width: number, height: number,
  appearance: { readonly cornerRadius?: number },
  corners: "all" | "top" | "left" = "all",
): PDFKit.PDFDocument {
  const radius = Math.min(appearance.cornerRadius ?? 0, width / 2, height / 2)
  // Historical archives retain the exact rect operator and deterministic PDF bytes.
  if (radius <= 0) return doc.rect(x, y, width, height)
  if (corners === "all") return doc.roundedRect(x, y, width, height, radius)
  const right = x + width, bottom = y + height, k = radius * 0.5522847498307936
  doc.moveTo(x + radius, y)
  if (corners === "top") {
    doc.lineTo(right - radius, y).bezierCurveTo(right - radius + k, y, right, y + radius - k, right, y + radius)
      .lineTo(right, bottom).lineTo(x, bottom)
  } else {
    doc.lineTo(right, y).lineTo(right, bottom).lineTo(x + radius, bottom)
      .bezierCurveTo(x + radius - k, bottom, x, bottom - radius + k, x, bottom - radius)
  }
  return doc.lineTo(x, y + radius).bezierCurveTo(x, y + radius - k, x + radius - k, y, x + radius, y).closePath()
}
