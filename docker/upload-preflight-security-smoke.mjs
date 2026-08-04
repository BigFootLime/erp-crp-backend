import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = "/app/data/preflight-smoke";
const roots = {
  documents: path.join(root, "documents"),
  generated: path.join(root, "generated"),
  inbound: path.join(root, "inbound"),
  exports: path.join(root, "exports"),
  tmp: path.join(root, "tmp"),
  images: path.join(root, "generated", "images"),
  ged: path.join(root, "ged"),
};
const postgresFile = path.join(root, "postgres", "PG_VERSION");
const inboundFile = path.join(roots.inbound, "integrations", "external.csv");

function assert(condition, message) {
  if (!condition) throw new Error(`[upload_preflight_smoke] ${message}`);
}

async function mode(candidate) {
  return (await fs.lstat(candidate)).mode & 0o7777;
}

async function digest(candidate) {
  return createHash("sha256").update(await fs.readFile(candidate)).digest("hex");
}

function configure() {
  process.env.CERP_STORAGE_ROOT = root;
  process.env.CERP_DOCUMENTS_ROOT = roots.documents;
  process.env.CERP_GENERATED_ROOT = roots.generated;
  process.env.CERP_INBOUND_ROOT = roots.inbound;
  process.env.CERP_EXPORTS_ROOT = roots.exports;
  process.env.CERP_TMP_ROOT = roots.tmp;
  process.env.CERP_IMAGES_ROOT = roots.images;
  process.env.CERP_GED_VAULT_ROOT = roots.ged;
}

configure();
const secure = await import("/app/dist/shared/uploads/secure-upload.js");

if (process.argv[2] === "prepare") {
  for (const directory of [root, ...Object.values(roots), path.join(roots.ged, "vault")]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o2770 });
  }
  for (const directory of [root, roots.documents, roots.generated, roots.inbound, roots.exports, roots.tmp]) {
    await fs.chmod(directory, 0o2770);
  }
  await fs.chmod(roots.ged, 0o2750);
  await fs.chmod(path.join(roots.ged, "vault"), 0o2770);
  const appFile = path.join(roots.documents, "document.pdf");
  const crossRoot = path.join(roots.documents, "cross-root.bin");
  await fs.writeFile(appFile, "document", { mode: 0o660 });
  await fs.chmod(appFile, 0o660);
  await fs.writeFile(crossRoot, "cross-root", { mode: 0o660 });
  await fs.chmod(crossRoot, 0o660);
  await fs.link(crossRoot, path.join(roots.tmp, "cross-root.bin"));
  const gedFile = path.join(roots.ged, "blob.bin");
  await fs.writeFile(gedFile, "ged", { mode: 0o660 });
  await fs.chmod(gedFile, 0o660);
  console.log("[upload_preflight_smoke] fixtures prepared");
} else if (process.argv[2] === "migrate") {
  const protectedBefore = await Promise.all([postgresFile, inboundFile].map(async (candidate) => ({
    candidate,
    digest: await digest(candidate),
    mode: await mode(candidate),
    stat: await fs.lstat(candidate),
  })));
  const appFile = path.join(roots.documents, "document.pdf");
  const appMtime = (await fs.lstat(appFile, { bigint: true })).mtimeNs;

  secure.preflightSecureUploadStorageRoots();

  assert(await mode(root) === 0o3770, "storage boundary 2770 did not gain sticky");
  assert(await mode(roots.documents) === 0o3770, "documents 2770 did not gain sticky");
  assert(await mode(roots.ged) === 0o2750, "GED 2750 access class was broadened");
  assert(await mode(path.join(roots.ged, "vault")) === 0o700, "GED private vault is not 0700");
  assert(await mode(appFile) === 0o600, "application file 0660 did not become 0600");
  assert(await mode(path.join(roots.ged, "blob.bin")) === 0o600, "GED file did not become 0600");
  assert((await fs.lstat(appFile, { bigint: true })).mtimeNs === appMtime, "application mtime changed");
  const crossA = await fs.lstat(path.join(roots.documents, "cross-root.bin"));
  const crossB = await fs.lstat(path.join(roots.tmp, "cross-root.bin"));
  assert(crossA.ino === crossB.ino && crossA.nlink === 2, "cross-root hardlink was not preserved");
  assert(await mode(path.join(roots.tmp, "cross-root.bin")) === 0o600, "cross-root inode not hardened");

  for (const before of protectedBefore) {
    const after = await fs.lstat(before.candidate);
    assert(await digest(before.candidate) === before.digest, "excluded file content changed");
    assert(await mode(before.candidate) === before.mode, "excluded file mode changed");
    assert(after.uid === before.stat.uid && after.gid === before.stat.gid, "excluded file owner changed");
    assert(after.mtimeMs === before.stat.mtimeMs, "excluded file mtime changed");
  }
  console.log("[upload_preflight_smoke] allowlist migration passed");
} else if (process.argv[2] === "reject-external-hardlink") {
  const external = path.join(root, "postgres", "external-hardlink.bin");
  const observed = [
    roots.documents,
    path.join(roots.documents, "document.pdf"),
    roots.generated,
    roots.tmp,
    path.join(roots.ged, "external-hardlink-source.bin"),
    external,
  ];
  const before = await Promise.all(observed.map(async (candidate) => {
    const stat = await fs.lstat(candidate);
    return {
      candidate,
      digest: stat.isFile() ? await digest(candidate) : null,
      mode: stat.mode & 0o7777,
      stat,
    };
  }));
  try {
    secure.preflightSecureUploadStorageRoots();
  } catch (error) {
    assert(error?.code === "UPLOAD_STAGING_PERMISSION_FAILED", "external hardlink did not fail closed");
    for (const snapshot of before) {
      const after = await fs.lstat(snapshot.candidate);
      assert(
        (after.mode & 0o7777) === snapshot.mode,
        `late failure changed mode for ${snapshot.candidate}`
      );
      assert(
        after.uid === snapshot.stat.uid && after.gid === snapshot.stat.gid,
        `late failure changed owner for ${snapshot.candidate}`
      );
      assert(
        after.mtimeMs === snapshot.stat.mtimeMs,
        `late failure changed mtime for ${snapshot.candidate}`
      );
      if (snapshot.digest !== null) {
        assert(
          await digest(snapshot.candidate) === snapshot.digest,
          `late failure changed content for ${snapshot.candidate}`
        );
      }
    }
    console.log("[upload_preflight_smoke] late external hardlink rejected with zero prior mutation");
    process.exit(0);
  }
  throw new Error("[upload_preflight_smoke] external hardlink unexpectedly accepted");
} else {
  throw new Error("[upload_preflight_smoke] unknown phase");
}
