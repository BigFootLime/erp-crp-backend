import multer from "multer";
import path from "path";
import { ensureImagesSubdir } from "../utils/imageStorage";

function sanitizeStem(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function splitSubdirectory(subdirectory?: string) {
  return (subdirectory ?? "")
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function createImageUpload(subdirectory?: string) {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, ensureImagesSubdir(...splitSubdirectory(subdirectory)));
    },
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname).toLowerCase();
      const stem = sanitizeStem(path.basename(file.originalname, ext)) || sanitizeStem(file.fieldname) || "image";
      cb(null, `${stem}-${uniqueSuffix}${ext}`);
    },
  });

  return multer({ storage });
}

export const upload = createImageUpload();
