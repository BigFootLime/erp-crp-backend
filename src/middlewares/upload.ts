import multer from "multer";
import path from "path";
import fs from "fs";

const reseauPath = path.resolve("\\\\192.168.1.245\\ERP\\CRP_SYSTEMS\\images");

// Assure-toi que le dossier existe
if (!fs.existsSync(reseauPath)) {
    fs.mkdirSync(reseauPath, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, reseauPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    }
});

export const upload = multer({ storage });
