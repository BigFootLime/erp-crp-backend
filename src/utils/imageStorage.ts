import fs from "fs"
import path from "path"
import { getGeneratedRootPath } from "./cerpStorage"

const DEFAULT_IMAGES_DIR = getGeneratedRootPath("images")

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "")
}

export function getImagesRootPath() {
  const configured = (process.env.CERP_IMAGES_ROOT ?? process.env.IMAGES_UPLOAD_DIR)?.trim()
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
  // Operational images are private application storage. A remote URL must
  // never be reclassified as a local key merely because its URL happens to
  // contain the historical `/uploads/images/` marker.
  if (/^https?:\/\//i.test(trimmed)) return null

  const normalized = trimmed.replace(/\\/g, "/")
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized) && !/^[a-z]:\//i.test(normalized)) return null
  // Validate the entire historic source before stripping the legacy marker:
  // a marker must not erase an earlier traversal component.
  if (/[\u0000-\u001F\u007F]/.test(normalized) || normalized.split("/").some((segment) => segment === "." || segment === "..")) return null
  const lowered = normalized.toLowerCase()
  const relativeMarker = "uploads/images/"
  const absoluteMarker = "/uploads/images/"
  const markerIndex = lowered.startsWith(relativeMarker)
    ? 0
    : (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized))
      ? lowered.indexOf(absoluteMarker)
      : -1

  if (markerIndex >= 0) {
    const markerLength = markerIndex === 0 ? relativeMarker.length : absoluteMarker.length
    const relative = normalized.slice(markerIndex + markerLength)
    const key = trimSlashes(relative)
    const segments = key.split("/")
    return key && !segments.some((segment) => segment === "" || segment === "." || segment === "..") && !key.includes(":")
      ? key
      : null
  }

  // Absolute drive/UNC paths without the known legacy marker are ambiguous
  // and must not collapse to an enumerable basename. Only canonical relative
  // keys are accepted.
  if (normalized.includes(":") || normalized.startsWith("/") || normalized.startsWith("//")) return null
  const key = trimSlashes(normalized)
  const segments = key.split("/")
  return key && !segments.some((segment) => segment === "" || segment === "." || segment === "..") ? key : null
}

export function buildPublicImageUrl(value: string | null | undefined) {
  if (!value) return null
  // Remote URLs never bypass the authenticated operational-media boundary.
  if (/^https?:\/\//i.test(value)) return null

  const normalized = normalizeStoredImagePath(value)
  if (!normalized) return null

  // A UUID is allocated by the media registry. This legacy synchronous helper
  // must fail closed until its caller has projected that UUID; deriving an ID
  // from a storage key would make the identifier enumerable.
  void normalized
  return null
}

export function resolveStoredImageAbsolutePath(value: string | null | undefined) {
  const normalized = normalizeStoredImagePath(value)
  if (!normalized || /^https?:\/\//i.test(normalized)) return null

  const root = getImagesRootPath()
  const absolute = path.resolve(root, normalized)
  return absolute === root || absolute.startsWith(`${root}${path.sep}`) ? absolute : null
}

export async function deleteStoredImageFile(value: string | null | undefined) {
  const absolute = resolveStoredImageAbsolutePath(value)
  if (!absolute) return
  await fs.promises.rm(absolute, { force: true })
}
