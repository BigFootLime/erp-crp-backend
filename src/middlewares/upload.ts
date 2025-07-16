import multer from "multer";
import path from "path";
import fs from "fs";

// Définir les chemins
const reseauPath = path.resolve("/home/bigfootlime/erp-crp/erp-crp-backend/uploads/images");
const localPath = path.resolve("uploads/images");

// Choisir dynamiquement le chemin en fonction de l’environnement
const isLocal = process.env.NODE_ENV === "development";
const uploadPath = isLocal ? localPath : reseauPath;

// S'assurer que le dossier existe
if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
}

// Configurer multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    },
});

export const upload = multer({ storage });
