import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { parseArgs } from "node:util";

import tabular from "../../dist/module/import-assistant/domain/tabular-file-parser.js";

const { parseTabularFile } = tabular;
const pollMs = 30_000;
const maxSize = 10 * 1024 * 1024;
const depositPath = "/client-portal/demand/carco";
const hash = (value) => createHash("sha256").update(value).digest("hex");

function config() {
  const { values } = parseArgs({ options: {
    api: { type: "string" },
    site: { type: "string" },
    workbook: { type: "string" },
    watch: { type: "boolean", default: false },
  } });
  if (!values.api || !values.site?.trim() || !values.workbook || !/\.xlsx$/i.test(values.workbook)) {
    throw new Error("Paramètres requis : --api URL/api/v1 --site CODE --workbook CHEMIN.xlsx [--watch].");
  }
  const api = new URL(values.api);
  const localHttp = api.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(api.hostname);
  if ((!localHttp && api.protocol !== "https:") || api.username || api.password || api.search || api.hash || api.pathname.replace(/\/$/, "") !== "/api/v1") {
    throw new Error("Utilisez l’URL CERP /api/v1 en HTTPS. HTTP fonctionne sur la boucle locale de recette.");
  }
  const email = process.env.CERP_CLAYENS_SYNC_EMAIL;
  const password = process.env.CERP_CLAYENS_SYNC_PASSWORD;
  if (!email || !password) throw new Error("Fournissez les identifiants du compte portail dédié via l’environnement du processus.");
  delete process.env.CERP_CLAYENS_SYNC_PASSWORD;
  const workbook = path.resolve(values.workbook);
  return {
    url: api.href.replace(/\/$/, ""), site: values.site.trim(), workbook, watch: values.watch,
    output: path.join(path.dirname(workbook), `${path.basename(workbook, path.extname(workbook))}.Retour-CERP.csv`),
    email, password,
  };
}

async function readSnapshot(workbook) {
  const before = await stat(workbook);
  if (!before.isFile() || before.size > maxSize) throw new Error("Taille du classeur hors limites (10 Mo).");
  if (Date.now() - before.mtimeMs < 5_000 && Date.now() >= before.mtimeMs) return null;
  const buffer = await readFile(workbook);
  const after = await stat(workbook);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
  const sheet = parseTabularFile({ originalname: path.basename(workbook), buffer }).sheets.find((entry) => entry.name === "Demandes");
  if (!sheet?.headers.includes("TRANSMETTRE")) throw new Error("L’onglet Demandes doit contenir la colonne TRANSMETTRE.");
  const selected = sheet.rows.filter((row) => String(row.TRANSMETTRE ?? "").trim().toUpperCase() === "OUI");
  return {
    buffer, asOf: after.mtime.toISOString(),
    fingerprint: hash(JSON.stringify(selected)),
    selected: selected.length,
  };
}

async function atomicWrite(destination, buffer) {
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, buffer, { flag: "wx" });
    await rename(temp, destination);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function main() {
  const settings = config();
  let session;
  let lastVersion;
  let lastReturn;
  async function request(endpoint, init = {}) {
    const response = await fetch(settings.url + endpoint, {
      ...init, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const code = typeof payload?.code === "string" && /^[A-Z0-9_]+$/.test(payload.code) ? ` ${payload.code}` : "";
      throw new Error(`CERP a répondu HTTP ${response.status}${code}.`);
    }
    return response;
  }
  async function portal(endpoint, init = {}) {
    if (!session || session.renewAt <= Date.now()) {
      const { token, expires_in_seconds } = await (await request("/portal/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: settings.email, password: settings.password }),
      })).json();
      if (typeof token !== "string" || !Number.isFinite(expires_in_seconds)) throw new Error("Session portail illisible.");
      session = { token, renewAt: Date.now() + Math.max(0, expires_in_seconds - 30) * 1_000 };
    }
    return request(endpoint, { ...init, headers: { Authorization: `Bearer ${session.token}` } });
  }

  do {
    try {
      const snapshot = await readSnapshot(settings.workbook);
      if (!snapshot && !settings.watch) throw new Error("Le classeur vient de changer. Attendez la fin de sa synchronisation.");
      if (snapshot) {
        const { sites, items } = await (await portal(depositPath)).json();
        if (!sites.includes(settings.site)) throw new Error("Le compte portail ne dispose pas du droit de dépôt sur ce site.");
        const version = `OneDrive-${snapshot.asOf}-${snapshot.fingerprint}`;
        const previous = items.find((item) => item.external_site === settings.site && item.latest
          && item.source_version.startsWith("OneDrive-") && item.source_version.endsWith(`-${snapshot.fingerprint}`));
        if (snapshot.selected && !previous && lastVersion !== version) {
          const form = new FormData();
          form.set("file", new Blob([snapshot.buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), path.basename(settings.workbook));
          form.set("external_site", settings.site);
          form.set("source_version", version);
          form.set("source_as_of", snapshot.asOf);
          form.set("complete_snapshot", "false");
          await portal(depositPath, { method: "POST", body: form });
          lastVersion = version;
          console.log(`[${new Date().toISOString()}] Relevé reçu par CERP (${snapshot.selected} ligne(s)).`);
        }
        if (previous?.latest && previous.processed) {
          const response = await portal(`${depositPath}/${encodeURIComponent(previous.id)}/return`);
          const buffer = Buffer.from(await response.arrayBuffer());
          const digest = hash(buffer);
          if (digest !== lastReturn) {
            const existing = await readFile(settings.output).catch((error) => {
              if (error.code !== "ENOENT") throw error;
              return Buffer.alloc(0);
            });
            if (!existing.equals(buffer)) {
              await atomicWrite(settings.output, buffer);
              console.log(`[${new Date().toISOString()}] Retour CERP disponible à côté du classeur.`);
            }
            lastReturn = digest;
          }
        }
      }
    } catch (error) {
      if (!settings.watch || /HTTP (401|403)|droit de dépôt/.test(error.message)) throw error;
      console.error(`[${new Date().toISOString()}] Synchronisation reportée : ${error.message}`);
    }
    if (settings.watch) await wait(pollMs);
  } while (settings.watch);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
