import path from "node:path";
import fs from "node:fs";
import multer from "multer";

// idéalement via env : process.env.CLIENT_LOGO_DIR
const LOGO_BASE_DIR = "\\\\192.168.1.245\\CRP SYSTEMS\\CLIENTS\\LOGOS";

// s'assurer que le dossier existe
if (!fs.existsSync(LOGO_BASE_DIR)) {
  fs.mkdirSync(LOGO_BASE_DIR, { recursive: true });
}

/**
 * Génère un nom de fichier du type :
 *   CLIENTID_DDMMYY_LOGO.ext
 */
function buildLogoFilename(clientId: string, originalName: string): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2); // 2025 -> 25
  const datePart = `${dd}${mm}${yy}`;

  const ext = path.extname(originalName) || ".png"; // fallback
  return `${clientId}_${datePart}_LOGO${ext}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, LOGO_BASE_DIR);
  },
  filename: (req, file, cb) => {
    const clientId = req.params.id; // récupéré depuis /clients/:id/logo
    const safeClientId = String(clientId || "").padStart(3, "0");
    const filename = buildLogoFilename(safeClientId, file.originalname);
    cb(null, filename);
  },
});

export const uploadClientLogoMulter = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 Mo
  },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Seuls les fichiers image sont autorisés"));
    }
    cb(null, true);
  },
});

export { LOGO_BASE_DIR, buildLogoFilename };
