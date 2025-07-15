// src/utils/checkNetworkDrive.ts

import fs from "fs";
import path from "path";

/**
 * Vérifie l’accessibilité du dossier réseau (ex: S:/CRP_SYSTEMS/images)
 * et d’un fichier test (par défaut : FRAISE-A-FILETER.svg)
 */
export const checkNetworkDrive = async () => {
    const basePath = path.resolve("\\\\192.168.1.245\\ERP\\CRP_SYSTEMS\\images");

    const testFile = "FRAISE-A-FILETER.svg";
    const fullTestPath = path.join(basePath, testFile);

    console.log(`🔍 Vérification du lecteur réseau : ${basePath}`);

    return new Promise<void>((resolve, reject) => {
        fs.access(basePath, fs.constants.F_OK, (err) => {
            if (err) {
                console.error("❌ Le dossier réseau S: est **inaccessible**. Vérifie que le lecteur est monté.");
                return reject();
            }

            console.log("✅ Le dossier réseau est accessible");

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
