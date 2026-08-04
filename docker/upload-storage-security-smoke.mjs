import fs from "node:fs/promises";
import path from "node:path";

const base = "/app/data/security-smoke";
const ancestor = path.join(base, "ancestor");
const expected = path.join(ancestor, "expected");
const privateDirectory = path.join(expected, ".private");

function assert(condition, message) {
  if (!condition) throw new Error(`[upload_storage_smoke] ${message}`);
}

async function mode(candidate) {
  return (await fs.lstat(candidate)).mode & 0o7777;
}

async function expectPermissionFailure(work, message) {
  try {
    await work();
  } catch (error) {
    assert(error?.code === "UPLOAD_STAGING_PERMISSION_FAILED", message);
    return;
  }
  throw new Error(`[upload_storage_smoke] ${message}`);
}

process.env.CERP_STORAGE_ROOT = base;
process.env.CERP_DOCUMENTS_ROOT = path.join(base, "documents");
process.env.CERP_GENERATED_ROOT = path.join(base, "generated");
process.env.CERP_INBOUND_ROOT = path.join(base, "inbound");
process.env.CERP_EXPORTS_ROOT = path.join(base, "exports");
process.env.CERP_TMP_ROOT = path.join(base, "tmp");
process.env.CERP_IMAGES_ROOT = path.join(base, "generated", "images");
const secure = await import("/app/dist/shared/uploads/secure-upload.js");

if (process.argv[2] === "setup") {
  await fs.mkdir(expected, { recursive: true, mode: 0o2770 });
  await Promise.all([
    fs.chmod(base, 0o2770),
    fs.chmod(ancestor, 0o2770),
    fs.chmod(expected, 0o2770),
  ]);
  secure.ensurePrivateUploadDirectory(privateDirectory, expected, base);
  await fs.writeFile(path.join(privateDirectory, "owned.bin"), "owned", {
    flag: "wx",
    mode: 0o600,
  });
  assert(await mode(base) === 0o3770, "configured 2770 root was not migrated to 3770");
  assert(await mode(ancestor) === 0o3770, "ancestor 2770 was not migrated to 3770");
  assert(await mode(expected) === 0o3770, "expectedRoot 2770 was not migrated to 3770");
  assert(await mode(privateDirectory) === 0o700, "private directory is not 0700");
  assert(await mode(path.join(privateDirectory, "owned.bin")) === 0o600, "private file is not 0600");

  for (const [name, initial] of [["non-escalation-2750", 0o2750], ["non-escalation-0755", 0o755]]) {
    const root = path.join("/app/data", name);
    await fs.mkdir(root, { mode: initial });
    await fs.chmod(root, initial);
    secure.ensurePrivateUploadDirectory(path.join(root, ".private"), root, root);
    assert(await mode(root) === initial, `${initial.toString(8)} access class was broadened`);
  }

  const thirdPartyRoot = "/app/data/third-owner/trusted";
  await expectPermissionFailure(
    () => Promise.resolve(secure.ensurePrivateUploadDirectory(
      path.join(thirdPartyRoot, ".private"),
      thirdPartyRoot,
      thirdPartyRoot
    )),
    "untrusted third-party ancestor owner was accepted"
  );
  console.log("[upload_storage_smoke] setup passed");
} else if (process.argv[2] === "verify-attacker") {
  await expectPermissionFailure(
    () => Promise.resolve(secure.ensurePrivateUploadDirectory(
      path.join(expected, "attacker-link"),
      expected,
      base
    )),
    "same-group symlink substitution was accepted"
  );
  await expectPermissionFailure(
    () => Promise.resolve(secure.ensurePrivateUploadDirectory(
      path.join(expected, "attacker-directory", "child"),
      expected,
      base
    )),
    "same-group attacker-owned directory was accepted"
  );
  assert(await fs.readFile(path.join(privateDirectory, "owned.bin"), "utf8") === "owned", "0600 file changed");
  console.log("[upload_storage_smoke] adversarial checks passed");
} else {
  throw new Error("[upload_storage_smoke] expected setup or verify-attacker");
}
