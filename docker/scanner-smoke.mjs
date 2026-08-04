import fs from "node:fs/promises";
import { createRequire } from "node:module";

import {
  assertUploadScannerConfiguration,
  scanUpload,
} from "/app/dist/shared/uploads/upload-scanner.js";

const cleanPath = "/tmp/cerp-clamav-clean.txt";
const infectedPath = "/tmp/cerp-clamav-eicar.txt";
const limitsPath = "/tmp/cerp-clamav-recursion-limit.zip";
const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const require = createRequire("/app/package.json");
const JSZip = require("jszip");

async function nestedArchive(depth) {
  let payload = Buffer.from("bounded scanner recursion fixture\n");
  for (let index = 0; index < depth; index += 1) {
    const archive = new JSZip();
    archive.file(`level-${index}.zip`, payload);
    payload = await archive.generateAsync({ type: "nodebuffer", compression: "STORE" });
  }
  return payload;
}

try {
  const configuration = assertUploadScannerConfiguration();
  if (configuration.mode !== "enforce" || configuration.provider !== "clamdscan") {
    throw new Error("scanner preflight is not enforce/clamdscan");
  }
  await fs.writeFile(cleanPath, "CERP scanner smoke fixture\n", { flag: "wx", mode: 0o600 });
  await fs.writeFile(infectedPath, eicar, { flag: "wx", mode: 0o600 });
  await fs.writeFile(limitsPath, await nestedArchive(20), { flag: "wx", mode: 0o600 });

  const cleanStat = await fs.stat(cleanPath);
  if ((cleanStat.mode & 0o777) !== 0o600) throw new Error("smoke fixture is not mode 0600");

  const clean = await scanUpload({ path: cleanPath });
  const streamed = await scanUpload({ buffer: Buffer.from("CERP in-memory scanner smoke fixture\n") });
  const infected = await scanUpload({ path: infectedPath });
  const exceeded = await scanUpload({ path: limitsPath });
  if (clean.status !== "clean" || clean.mode !== "enforce") {
    throw new Error(`clean scan failed: ${clean.status}/${clean.mode}`);
  }
  if (infected.status !== "infected" || infected.mode !== "enforce") {
    throw new Error(`EICAR scan failed: ${infected.status}/${infected.mode}`);
  }
  if (streamed.status !== "clean" || streamed.mode !== "enforce") {
    throw new Error(`stream scan failed: ${streamed.status}/${streamed.mode}`);
  }
  if (exceeded.status !== "infected" || exceeded.mode !== "enforce") {
    throw new Error(`scan limit was not rejected: ${exceeded.status}/${exceeded.mode}`);
  }
  process.stdout.write(
    "scanner-smoke: file0600=clean stream=clean infected=infected limits=infected mode=enforce\n"
  );
} finally {
  await Promise.all([
    fs.unlink(cleanPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    }),
    fs.unlink(infectedPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    }),
    fs.unlink(limitsPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    }),
  ]);
}
