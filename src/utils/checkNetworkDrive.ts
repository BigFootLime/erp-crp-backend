import fs from "fs";
import path from "path";
import { getImagesRootPath } from "./imageStorage";

/**
 * Vérifie l’accessibilité du dossier d’upload (local ou réseau)
 * et d’un fichier test (par défaut : FRAISE-A-FILETER.svg)
 */
export const checkNetworkDrive = async () => {
    const basePath = getImagesRootPath();

    const testFile = "FRAISE-A-FILETER.svg";
    const fullTestPath = path.join(basePath, testFile);

    console.log(`🔍 Vérification du dossier d’upload : ${basePath}`);

    return new Promise<void>((resolve, reject) => {
        fs.access(basePath, fs.constants.F_OK, (err) => {
            if (err) {
                console.error(`❌ Le dossier "${basePath}" est **inaccessible**.`);
                return reject();
            }

            console.log("✅ Le dossier est accessible");

            fs.access(fullTestPath, fs.constants.F_OK, (errFile) => {
                if (errFile) {
                    console.warn(`⚠️ Le fichier test "${testFile}" est introuvable dans le dossier.`);
                } else {
                    console.log(`✅ Le fichier test "${testFile}" est lisible`);
                }
                resolve();
            });
        });
    });
};
