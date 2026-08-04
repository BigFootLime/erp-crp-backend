import fs from "node:fs";
import path from "node:path";

const ALLOWED_MOUNT_ROOTS = ["/app/data", "/app/uploads"];
const DATA_PARENT_MODE = 0o750;
const PRIVATE_MODE = 0o700;
const FILE_MODE = 0o600;
const MODE_MASK = 0o7777;
const nodeUid = Number.parseInt(process.env.CERP_APP_UID ?? "", 10);
const nodeGid = Number.parseInt(process.env.CERP_APP_GID ?? "", 10);
const maxNodes = Number.parseInt(process.env.CERP_STORAGE_PREFLIGHT_MAX_NODES ?? "1000000", 10);

if (
  !Number.isInteger(nodeUid)
  || !Number.isInteger(nodeGid)
  || !Number.isSafeInteger(maxNodes)
  || maxNodes < 1
  || maxNodes > 1000000
  || process.geteuid?.() !== 0
) {
  throw new Error("[upload_storage] storage preflight requires root and explicit app uid/gid");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function normalizeConfiguredRoot(value, fallback) {
  const resolved = path.resolve(value?.trim() || fallback);
  if (!ALLOWED_MOUNT_ROOTS.some((root) => inside(root, resolved))) {
    throw new Error("[upload_storage] configured root is outside allowlisted mounts");
  }
  return resolved;
}

const storageRoot = normalizeConfiguredRoot(process.env.CERP_STORAGE_ROOT, "/app/data");
const configuredRoots = {
  storage: storageRoot,
  documents: normalizeConfiguredRoot(process.env.CERP_DOCUMENTS_ROOT, path.join(storageRoot, "documents")),
  generated: normalizeConfiguredRoot(process.env.CERP_GENERATED_ROOT, path.join(storageRoot, "generated")),
  inbound: normalizeConfiguredRoot(process.env.CERP_INBOUND_ROOT, path.join(storageRoot, "inbound")),
  exports: normalizeConfiguredRoot(process.env.CERP_EXPORTS_ROOT, path.join(storageRoot, "exports")),
  tmp: normalizeConfiguredRoot(process.env.CERP_TMP_ROOT, path.join(storageRoot, "tmp")),
  images: normalizeConfiguredRoot(
    process.env.CERP_IMAGES_ROOT ?? process.env.IMAGES_UPLOAD_DIR,
    path.join(process.env.CERP_GENERATED_ROOT?.trim() || path.join(storageRoot, "generated"), "images")
  ),
  ...(process.env.CERP_GED_VAULT_ROOT?.trim()
    ? { ged: normalizeConfiguredRoot(process.env.CERP_GED_VAULT_ROOT) }
    : {}),
};

function identityKey(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function inventoryRoot(root) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("[upload_storage] mount root is not a real directory");
  }
  const allowedOwners = new Set([
    `${nodeUid}:${nodeGid}`,
    `${rootStat.uid}:${rootStat.gid}`,
  ]);
  const directories = [];
  const files = [];
  const observedLinks = new Map();
  const pending = [root];
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > maxNodes) {
      throw new Error("[upload_storage] mounted storage inventory exceeds configured bound");
    }
    const stat = fs.lstatSync(current);
    const owner = `${stat.uid}:${stat.gid}`;
    if (!allowedOwners.has(owner)) {
      throw new Error("[upload_storage] unexpected owner in mounted storage");
    }
    if (stat.isSymbolicLink()) {
      throw new Error("[upload_storage] symlink found in mounted storage");
    }
    const record = {
      path: current,
      dev: stat.dev,
      ino: stat.ino,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode & MODE_MASK,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    if (stat.isDirectory()) {
      directories.push(record);
      const entries = fs.readdirSync(current);
      for (const entry of entries) pending.push(path.join(current, entry));
    } else if (stat.isFile()) {
      files.push(record);
      const key = identityKey(stat);
      observedLinks.set(key, (observedLinks.get(key) ?? 0) + 1);
    } else {
      throw new Error("[upload_storage] special inode found in mounted storage");
    }
  }

  for (const file of files) {
    if (observedLinks.get(`${file.dev}:${file.ino}`) !== file.nlink) {
      throw new Error("[upload_storage] hardlink escapes mounted storage inventory");
    }
  }
  directories.sort((left, right) => left.path.length - right.path.length);
  return { root, directories, files, visited };
}

function isPrivateDirectory(candidate) {
  // Docker has one application writer. Keep only the traversal parent
  // /app/data at 0750; every mounted application subtree is node-private.
  return candidate !== "/app/data";
}

function mutateVerified(record, mode, directory) {
  const flags = fs.constants.O_RDONLY
    | fs.constants.O_NOFOLLOW
    | (directory ? fs.constants.O_DIRECTORY : 0);
  const descriptor = fs.openSync(record.path, flags);
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== record.dev
      || opened.ino !== record.ino
      || (directory ? !opened.isDirectory() : !opened.isFile())
      || opened.uid !== record.uid
      || opened.gid !== record.gid
      || (opened.mode & MODE_MASK) !== record.mode
      || opened.size !== record.size
      || opened.mtimeMs !== record.mtimeMs
    ) {
      throw new Error("[upload_storage] inode or metadata changed during migration");
    }
    fs.fchownSync(descriptor, nodeUid, nodeGid);
    fs.fchmodSync(descriptor, mode);
    const secured = fs.fstatSync(descriptor);
    if (
      secured.dev !== record.dev
      || secured.ino !== record.ino
      || secured.uid !== nodeUid
      || secured.gid !== nodeGid
      || (secured.mode & MODE_MASK) !== mode
      || secured.size !== record.size
      || secured.mtimeMs !== record.mtimeMs
    ) {
      throw new Error("[upload_storage] migration postcondition failed");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function migrateInventory(inventory) {
  // Parents first: each parent reaches its final access class before children.
  for (const directory of inventory.directories) {
    mutateVerified(directory, isPrivateDirectory(directory.path) ? PRIVATE_MODE : DATA_PARENT_MODE, true);
  }
  const migratedFiles = new Set();
  for (const file of inventory.files) {
    const key = `${file.dev}:${file.ino}`;
    if (migratedFiles.has(key)) continue;
    mutateVerified(file, FILE_MODE, false);
    migratedFiles.add(key);
  }
  console.log(
    `[upload_storage] migrated root=${inventory.root} dirs=${inventory.directories.length} files=${inventory.files.length}`
  );
}

function secureCreatedDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("[upload_storage] configured path component is not a real directory");
  }
  mutateVerified(
    {
      path: directory,
      dev: stat.dev,
      ino: stat.ino,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode & MODE_MASK,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    },
    directory === "/app/data" ? DATA_PARENT_MODE : PRIVATE_MODE,
    true
  );
}

function createConfiguredRoot(directory) {
  const mount = ALLOWED_MOUNT_ROOTS.find((root) => inside(root, directory));
  if (!mount) throw new Error("[upload_storage] configured root escaped allowlist");
  let current = mount;
  for (const segment of path.relative(mount, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: PRIVATE_MODE });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    secureCreatedDirectory(current);
  }
}

function verifyPostconditions(root) {
  const inventory = inventoryRoot(root);
  for (const directory of inventory.directories) {
    const stat = fs.lstatSync(directory.path);
    const expected = isPrivateDirectory(directory.path) ? PRIVATE_MODE : DATA_PARENT_MODE;
    if (stat.uid !== nodeUid || stat.gid !== nodeGid || (stat.mode & MODE_MASK) !== expected) {
      throw new Error("[upload_storage] directory postcondition mismatch");
    }
  }
  for (const file of inventory.files) {
    const stat = fs.lstatSync(file.path);
    if (stat.uid !== nodeUid || stat.gid !== nodeGid || (stat.mode & MODE_MASK) !== FILE_MODE) {
      throw new Error("[upload_storage] file postcondition mismatch");
    }
  }
}

// Inventory every allowed mount before the first mutation. A mixed owner tree,
// symlink, special inode or out-of-tree hardlink fails closed and stays intact.
const initial = ALLOWED_MOUNT_ROOTS.map(inventoryRoot);
if (initial.reduce((sum, inventory) => sum + inventory.visited, 0) > maxNodes) {
  throw new Error("[upload_storage] mounted storage inventory exceeds configured bound");
}
for (const inventory of initial) migrateInventory(inventory);
for (const root of new Set(Object.values(configuredRoots))) createConfiguredRoot(root);
for (const root of ALLOWED_MOUNT_ROOTS) verifyPostconditions(root);
console.log(`[upload_storage] preflight ready configured_roots=${Object.keys(configuredRoots).length}`);
