import fs from "fs"
import path from "path"

const DEFAULT_IMAGES_DIR = path.resolve("uploads/images")

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "")
}

export function getImagesRootPath() {
  const configured = process.env.IMAGES_UPLOAD_DIR?.trim()
  return path.resolve(configured && configured.length ? configured : DEFAULT_IMAGES_DIR)
}

export function ensureImagesSubdir(...segments: string[]) {
  const dir = path.join(getImagesRootPath(), ...segments.filter(Boolean))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function toStoredImagePath(...segments: string[]) {
  return segments
    .flatMap((segment) => segment.replace(/\\/g, "/").split("/"))
    .map((segment) => trimSlashes(segment))
    .filter(Boolean)
    .join("/")
}

export function normalizeStoredImagePath(value: string | null | undefined) {
  if (!value) return null

  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  const normalized = trimmed.replace(/\\/g, "/")
  const marker = "/uploads/images/"
  const lowered = normalized.toLowerCase()
  const markerIndex = lowered.lastIndexOf(marker)

  if (markerIndex >= 0) {
    const relative = normalized.slice(markerIndex + marker.length)
    return trimSlashes(relative)
  }

  if (!normalized.includes(":") && !normalized.startsWith("//")) {
    return trimSlashes(normalized)
  }

  const basename = path.posix.basename(normalized)
  return basename ? trimSlashes(basename) : null
}

export function buildPublicImageUrl(value: string | null | undefined) {
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return value

  const normalized = normalizeStoredImagePath(value)
  if (!normalized) return null

  const baseUrl = process.env.BACKEND_URL?.trim().replace(/\/+$/, "")
  return baseUrl ? `${baseUrl}/images/${normalized}` : `/images/${normalized}`
}

export function resolveStoredImageAbsolutePath(value: string | null | undefined) {
  const normalized = normalizeStoredImagePath(value)
  if (!normalized || /^https?:\/\//i.test(normalized)) return null

  const root = getImagesRootPath()
  const absolute = path.resolve(root, normalized)
  return absolute.startsWith(root) ? absolute : null
}

export async function deleteStoredImageFile(value: string | null | undefined) {
  const absolute = resolveStoredImageAbsolutePath(value)
  if (!absolute) return
  await fs.promises.rm(absolute, { force: true })
}
