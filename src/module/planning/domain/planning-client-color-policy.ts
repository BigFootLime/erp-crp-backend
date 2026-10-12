/** Red hues are reserved for delays, blocking issues and faults in the planning. */
export function isReservedPlanningClientColor(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  if (max !== r || delta === 0 || delta / max < 0.15) return false
  const hue = (((g - b) / delta) * 60 + 360) % 360
  return hue < 25 || hue >= 345
}
