// // src/module/client/upload/client-logo-upload.ts
// import path from "node:path";
// import fs from "node:fs";
// import multer from "multer";

// // 🔁 Base côté VPS = montage du Windows
// // /mnt/crp  <->  C:\CRP_SYSTEMS
// // Donc ici on pointe sur le dossier CLIENTS
// export const LOGO_BASE_DIR = process.env.CLIENT_LOGO_DIR || "/mnt/crp/CLIENTS";

// // s'assurer que le dossier CLIENTS existe
// if (!fs.existsSync(LOGO_BASE_DIR)) {
//   fs.mkdirSync(LOGO_BASE_DIR, { recursive: true });
// }

// /**
//  * Génère un nom de fichier du type :
//  *   CLIENTID_DDMMYY_LOGO.ext
//  */
// export function buildLogoFilename(clientId: string, originalName: string): string {
//   const now = new Date();
//   const dd = String(now.getDate()).padStart(2, "0");
//   const mm = String(now.getMonth() + 1).padStart(2, "0");
//   const yy = String(now.getFullYear()).slice(-2); // 2025 -> 25
//   const datePart = `${dd}${mm}${yy}`;

//   const ext = path.extname(originalName) || ".png"; // fallback
//   return `${clientId}_${datePart}_LOGO${ext}`;
// }

// const storage = multer.diskStorage({
//   destination: (req, _file, cb) => {
//     const rawId = req.params.id;
//     const safeClientId = String(rawId || "").padStart(3, "0");

//     // ➜ /mnt/crp/CLIENTS/005/LOGOS
//     const clientDir = path.join(LOGO_BASE_DIR, safeClientId, "LOGOS");

//     // crée récursivement le dossier si besoin
//     fs.mkdirSync(clientDir, { recursive: true });

//     cb(null, clientDir);
//   },
//   filename: (req, file, cb) => {
//     const rawId = req.params.id;
//     const safeClientId = String(rawId || "").padStart(3, "0");
//     const filename = buildLogoFilename(safeClientId, file.originalname);
//     cb(null, filename);
//   },
// });

// export const uploadClientLogoMulter = multer({
//   storage,
//   limits: {
//     fileSize: 5 * 1024 * 1024, // 5 Mo
//   },
//   fileFilter: (_req, file, cb) => {
//     if (!file.mimetype.startsWith("image/")) {
//       return cb(new Error("Seuls les fichiers image sont autorisés"));
//     }
//     cb(null, true);
//   },
// });
